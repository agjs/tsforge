import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  resolveGreenfieldStack,
  greenfieldConstraints,
  greenfieldOrSend,
} from "../src/cli/repl";
import type { IStackAdapter } from "../src/loop/planning/stack-adapter";

/** A stub adapter with fixed id + detection. `planConstraints` FORWARDS the caller's
 *  reporter into the returned constraint, so greenfieldConstraints' echo wiring is
 *  observable (the adapter contract the real boringstack adapter also honors). */
const stub = (id: string, matches: boolean): IStackAdapter => ({
  id,
  detect: () => Promise.resolve(matches),
  planConstraints: (onStripped) => ({
    reservedEntities: new Set([`${id}-reserved`]),
    onStripped,
  }),
});

const noApprovedPlan = (): Promise<boolean> => Promise.resolve(false);
const hasApprovedPlan = (): Promise<boolean> => Promise.resolve(true);

describe("resolveGreenfieldStack (the REPL interception decision)", () => {
  test("a detected project with NO approved plan → returns the EXACT detected adapter", async () => {
    const first = stub("other", false);
    const detected = stub("boringstack", true);

    const resolved = await resolveGreenfieldStack(
      "/dir",
      [first, detected],
      noApprovedPlan
    );

    // Not merely non-null — the SAME adapter object, so a wrong-adapter wiring would fail.
    expect(resolved).toBe(detected);
  });

  test("a detected project that is ALREADY planned → null (bypass, no re-planning)", async () => {
    const resolved = await resolveGreenfieldStack(
      "/dir",
      [stub("boringstack", true)],
      hasApprovedPlan
    );

    expect(resolved).toBeNull();
  });

  test("no adapter detects the project → null (proceed normally)", async () => {
    const resolved = await resolveGreenfieldStack(
      "/dir",
      [stub("a", false), stub("b", false)],
      noApprovedPlan
    );

    expect(resolved).toBeNull();
  });

  test("hasApprovedPlan is only consulted for a detected project (short-circuit)", async () => {
    let consulted = false;
    const resolved = await resolveGreenfieldStack(
      "/dir",
      [stub("a", false)],
      () => {
        consulted = true;

        return Promise.resolve(false);
      }
    );

    expect(resolved).toBeNull();
    expect(consulted).toBe(false);
  });
});

describe("greenfieldConstraints (resolved adapter supplies the constraints)", () => {
  test("uses the RESOLVED adapter's planConstraints and routes drops to the echo sink", () => {
    const echoed: string[] = [];
    const constraints = greenfieldConstraints(stub("boringstack", true), (s) =>
      echoed.push(s)
    );

    // The adapter's own reserved-entity rule is carried through…
    expect(constraints.reservedEntities?.has("boringstack-reserved")).toBe(
      true
    );

    // …and a strip is surfaced to the user via echo, naming the resolved stack.
    constraints.onStripped?.(["user", "auth"]);
    const out = echoed.join("");

    expect(out).toContain("boringstack");
    expect(out).toContain("user, auth");
  });
});

// greenfieldOrSend IS the interception branch. Testing it behaviorally proves the property
// the readline handler relies on — the resolved stack controls the planning path, and an
// unmatched/already-planned project falls through to the normal send — without driving the
// whole REPL. EXACTLY ONE continuation runs.
describe("greenfieldOrSend (the interception branch)", () => {
  /** Counts each continuation's invocations, so tests assert exactly-once cardinality (not just
   *  exclusivity — calling the selected branch twice must also fail). Records the stack the
   *  planning branch received. The explicit type annotation makes `stack` nullable without an
   *  `as` cast (house rule: no casts, incl. tests). */
  interface ISpy {
    greenfield: number;
    send: number;
    stack: IStackAdapter | null;
    onGreenfield: (s: IStackAdapter) => Promise<void>;
    onSend: () => Promise<void>;
  }

  const spy = (): ISpy => {
    const s: ISpy = {
      greenfield: 0,
      send: 0,
      stack: null,
      onGreenfield: (adapter: IStackAdapter): Promise<void> => {
        s.greenfield += 1;
        s.stack = adapter;

        return Promise.resolve();
      },
      onSend: (): Promise<void> => {
        s.send += 1;

        return Promise.resolve();
      },
    };

    return s;
  };

  test("a detected+unplanned project runs onGreenfield EXACTLY once with the EXACT stack, never onSend", async () => {
    const detected = stub("boringstack", true);
    const s = spy();

    await greenfieldOrSend(
      "/dir",
      [stub("other", false), detected],
      noApprovedPlan,
      s.onGreenfield,
      s.onSend
    );

    expect(s.greenfield).toBe(1);
    expect(s.send).toBe(0);
    expect(s.stack).toBe(detected);
  });

  test("an undetected project runs onSend EXACTLY once, never onGreenfield", async () => {
    const s = spy();

    await greenfieldOrSend(
      "/dir",
      [stub("a", false)],
      noApprovedPlan,
      s.onGreenfield,
      s.onSend
    );

    expect(s.send).toBe(1);
    expect(s.greenfield).toBe(0);
  });

  test("a detected but ALREADY-planned project runs onSend EXACTLY once, never onGreenfield", async () => {
    const s = spy();

    await greenfieldOrSend(
      "/dir",
      [stub("boringstack", true)],
      hasApprovedPlan,
      s.onGreenfield,
      s.onSend
    );

    expect(s.send).toBe(1);
    expect(s.greenfield).toBe(0);
  });
});

// The remaining glue — the readline line handler CALLING greenfieldOrSend with the
// composition-root registry and both continuations — lives inside repl()'s readline closure,
// which is not unit-reachable. A source-TEXT guard (regex over the file) cannot distinguish
// executable code from a string / comment / template / unreachable copy of the same shape. So
// this guard matches the AST STRUCTURALLY via ast-grep (the repo's own tool — see
// loop/astgrep-fix.ts): the pattern is the EXACT wiring, and ast-grep matches it only as a real
// call-expression node. This closes BOTH classes the reviewers raised: (a) code-vs-literal — a
// string/comment/template copy is not a call node, so it can never match; (b) shape bypasses —
// the pattern pins ALL THREE arguments, so a sending hasPlan, a block-body onGreenfield, or a
// send chained onto planning is a DIFFERENT AST node and fails. The one thing outside the call
// node is a trailing send AFTER it; the terminal-statement check closes that. Plan-XOR-send
// SEMANTICS are proven by the greenfieldOrSend behavioral test above.
const AST_GREP = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "node_modules",
  ".bin",
  "ast-grep"
);
const REPL_TS = join(import.meta.dir, "..", "src", "cli", "repl.ts");

// The EXACT wiring, as an ast-grep pattern (all args pinned, no metavariables). A match is a
// real call-expression node with this precise shape.
const STRICT =
  "await greenfieldOrSend(args.dir, STACK_ADAPTERS, async (d) => (await loadApprovedPlan(d)) !== null, (stack) => runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack), () => runSend(line))";

interface IMatch {
  text: string;
  endByte: number;
}

/** Parse one ast-grep JSON match into {text, endByte}, FAILING CLOSED on any unexpected shape
 *  (never masking a schema change as an empty match). No `as` casts (house rule). */
const toMatch = (m: unknown): IMatch => {
  if (
    m !== null &&
    typeof m === "object" &&
    "text" in m &&
    typeof m.text === "string" &&
    "range" in m &&
    m.range !== null &&
    typeof m.range === "object" &&
    "byteOffset" in m.range &&
    m.range.byteOffset !== null &&
    typeof m.range.byteOffset === "object" &&
    "end" in m.range.byteOffset &&
    typeof m.range.byteOffset.end === "number"
  ) {
    return { text: m.text, endByte: m.range.byteOffset.end };
  }

  throw new Error(
    "ast-grep match missing string `text` / numeric range.byteOffset.end"
  );
};

/** Structurally match `pattern` over `file` via ast-grep. ast-grep exits 0 when it finds
 *  matches and 1 when it finds NONE (both print valid JSON — `[…]` / `[]`), so success is
 *  "stdout parses to a JSON array", not the exit code. Throws (never silently passes) if
 *  ast-grep is absent or errors — its stdout won't be a JSON array — so the guard cannot vanish. */
const astFind = (pattern: string, file: string): IMatch[] => {
  const proc = Bun.spawnSync([
    AST_GREP,
    "run",
    "-p",
    pattern,
    "-l",
    "ts",
    "--json",
    file,
  ]);

  let parsed: unknown;

  try {
    parsed = JSON.parse(proc.stdout.toString());
  } catch {
    throw new Error(
      `ast-grep produced no JSON (exit ${proc.exitCode}) on ${file}: ${proc.stderr.toString()}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`ast-grep did not return a JSON array on ${file}`);
  }

  return parsed.map(toMatch);
};

/** Run STRICT over an arbitrary source string (via a temp file), for negative decoys. */
const strictOn = async (source: string): Promise<IMatch[]> => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-guard-"));

  try {
    const file = join(dir, "decoy.ts");

    await writeFile(file, source);

    return astFind(STRICT, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** True iff the greenfieldOrSend call ending at `endByte` is a TERMINAL statement — only `;`
 *  and the closing `}` follow. A trailing `await runSend(line)` (plan-THEN-send) breaks this. */
const isTerminalStatement = (source: string, endByte: number): boolean =>
  /^\s*;\s*\}/.test(
    Buffer.from(source, "utf8").subarray(endByte).toString("utf8")
  );

describe("the REPL line handler wires greenfieldOrSend (ast-grep structural guard)", () => {
  test("exactly one call node with the EXACT wiring, as the terminal statement", async () => {
    const src = await Bun.file(REPL_TS).text();
    const matches = astFind(STRICT, REPL_TS);

    // Exactly ONE real call node matching the full pinned shape — pins the registry, the
    // hasPlan predicate, and both continuations at the AST level.
    expect(matches.length).toBe(1);

    // …and it is the handler's terminal statement, so nothing sends after it (plan-THEN-send).
    expect(isTerminalStatement(src, matches[0]?.endByte ?? -1)).toBe(true);
  });

  // NEGATIVE regression tests — each plan-THEN-send / decoy the reviewers raised must yield ZERO
  // STRICT matches (or fail the terminal check), proving the guard actually rejects it.
  const wrap = (call: string): string =>
    `async function h() {\n  ${call};\n}\n`;
  const CORRECT_CALL =
    "await greenfieldOrSend(args.dir, STACK_ADAPTERS, async (d) => (await loadApprovedPlan(d)) !== null, (stack) => runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack), () => runSend(line))";

  test("rejects a block-body onGreenfield that plans then sends (different AST node)", async () => {
    const bypass =
      "await greenfieldOrSend(args.dir, STACK_ADAPTERS, async (d) => (await loadApprovedPlan(d)) !== null, (stack) => { runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack); runSend(line); }, () => runSend(line))";

    expect((await strictOn(wrap(bypass))).length).toBe(0);
  });

  test("rejects a send chained onto runGreenfieldPlanning (.finally)", async () => {
    const bypass =
      "await greenfieldOrSend(args.dir, STACK_ADAPTERS, async (d) => (await loadApprovedPlan(d)) !== null, (stack) => runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack).finally(() => runSend(line)), () => runSend(line))";

    expect((await strictOn(wrap(bypass))).length).toBe(0);
  });

  test("rejects a hasApprovedPlan predicate that sends (different AST node)", async () => {
    const bypass =
      "await greenfieldOrSend(args.dir, STACK_ADAPTERS, () => runSend(line).then(() => false), (stack) => runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack), () => runSend(line))";

    expect((await strictOn(wrap(bypass))).length).toBe(0);
  });

  test("rejects string / comment / template copies of the exact call (not call nodes)", async () => {
    const asString = `const a = ${JSON.stringify(CORRECT_CALL)};`;
    const asComment = `// ${CORRECT_CALL}`;
    const asTemplate = "const b = `" + CORRECT_CALL + "`;";

    expect((await strictOn(asString)).length).toBe(0);
    expect((await strictOn(asComment)).length).toBe(0);
    expect((await strictOn(asTemplate)).length).toBe(0);
  });

  test("rejects a trailing runSend after the correct call (fails the terminal check)", async () => {
    const src = `async function h() {\n  ${CORRECT_CALL};\n  await runSend(line);\n}\n`;
    const matches = await strictOn(src);

    // The call node itself still matches (it IS correct) …
    expect(matches.length).toBe(1);
    // … but it is NOT the terminal statement — a send follows — so the guard rejects it here.
    expect(isTerminalStatement(src, matches[0]?.endByte ?? -1)).toBe(false);
  });
});
