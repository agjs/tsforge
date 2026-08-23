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
  planSchema: { system: "", validateUi: (_v: unknown): _v is unknown => true },
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

  test("consults hasApprovedPlan with the DIR and the EXACT resolved adapter (its schema drives the check)", async () => {
    // The approved-plan check must run against the RESOLVED adapter's plan schema, not a fixed one
    // — so resolveGreenfieldStack must hand hasApprovedPlan (dir, detectedAdapter). Capture the
    // args and assert identity; a regression that drops the stack arg or passes the wrong adapter
    // (so a second stack's plans would be validated by boringstack's schema) fails here.
    const detected = stub("boringstack", true);
    // Capture into an array (not a reassigned local) so the compiler doesn't flow-narrow the
    // closure-mutated value to `never` at the assertion site.
    const calls: { dir: string; stack: IStackAdapter }[] = [];

    const resolved = await resolveGreenfieldStack(
      "/dir",
      [stub("other", false), detected],
      (dir, stack) => {
        calls.push({ dir, stack });

        return Promise.resolve(false);
      }
    );

    expect(resolved).toBe(detected);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.dir).toBe("/dir");
    expect(calls[0]?.stack).toBe(detected);
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
// which is not unit-reachable. This guard matches the AST STRUCTURALLY via ast-grep (the repo's
// own tool — see loop/astgrep-fix.ts) with ONE pattern that pins the exact call as the FINAL
// statement of an `async (line: string): Promise<void> => {…}` arrow (the runLine handler's
// signature).
//
// WHAT IT GUARANTEES (each verified by a committed negative below):
//   - code-vs-literal: a string/comment/template copy is not a call node → no match;
//   - shape: all three args are pinned literal, so a sending hasPlan / block-body onGreenfield /
//     send chained onto planning is a DIFFERENT node → no match;
//   - nothing sends AFTER it: the call is the arrow body's LAST statement, so a call nested in an
//     inner if/try/arrow, or with any statement after it (a trailing send), is not last → no match.
//
// WHAT IT DOES NOT (and cannot, statically) guarantee: that no UNCONDITIONAL send runs BEFORE the
// call. The real handler legitimately contains conditional `runSend(line)` in earlier branches
// that `return` first (plan-discuss/approval), so a blanket "reject any preceding send" would
// reject the real handler — telling an unconditional preceding send from a return-guarded one is
// control-flow analysis, not pattern matching. NOTE the greenfieldOrSend behavioral test does NOT
// cover this either: it proves the two continuations are mutually exclusive INSIDE greenfieldOrSend,
// but never sees a `runSend(line)` the caller runs BEFORE invoking it. Only the real build/e2e path
// (which executes the actual handler) — or full control-flow analysis — exercises a preceding
// send. This guard pins the wiring's shape and terminal position, not the handler's control flow.
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

// The exact wiring, pinned as the LAST statement (`$$$BODY` absorbs everything before it) of the
// runLine arrow — identified by its exact signature. All args are literal (no metavariables).
const ANCHORED =
  "async (line: string): Promise<void> => { $$$BODY await greenfieldOrSend(args.dir, STACK_ADAPTERS, async (d, s) => session.getPendingPlan() !== null || (await stackHasProductPlan(d, s)), (stack) => planProduct(stack, line), () => runSend(line)); }";

/** Count structural matches of `pattern` over `file` via ast-grep. ast-grep exits 0 with matches
 *  and 1 with none (both print valid JSON — `[…]` / `[]`), so success is "stdout parses to a JSON
 *  array", not the exit code. Throws (never silently passes) if ast-grep is absent or errors — its
 *  stdout won't be a JSON array — so the guard cannot silently vanish. */
const countMatches = (pattern: string, file: string): number => {
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

  return parsed.length;
};

/** Count matches of `pattern` over an arbitrary source string (via a temp file), for decoys. */
const countOnPat = async (pattern: string, source: string): Promise<number> => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-guard-"));

  try {
    const file = join(dir, "decoy.ts");

    await writeFile(file, source);

    return countMatches(pattern, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Count ANCHORED matches over an arbitrary source string (via a temp file), for decoys. */
const countOn = (source: string): Promise<number> =>
  countOnPat(ANCHORED, source);

describe("the REPL line handler wires greenfieldOrSend (ast-grep structural guard)", () => {
  test("the real handler has exactly one greenfieldOrSend call as its arrow's LAST statement", () => {
    expect(countMatches(ANCHORED, REPL_TS)).toBe(1);
  });

  // NEGATIVE regression tests — each decoy the reviewers raised must yield ZERO ANCHORED matches.
  // Every decoy uses the REAL handler-arrow shape, so it is the exact context the guard runs in.
  const wrapArrow = (body: string): string =>
    `const runLine = async (line: string): Promise<void> => {\n  ${body}\n};\n`;
  const CORRECT_CALL =
    "await greenfieldOrSend(args.dir, STACK_ADAPTERS, async (d, s) => session.getPendingPlan() !== null || (await stackHasProductPlan(d, s)), (stack) => planProduct(stack, line), () => runSend(line))";

  test("SANITY: the correct arrow shape matches (so the negatives fail for the right reason)", async () => {
    expect(await countOn(wrapArrow(`${CORRECT_CALL};`))).toBe(1);
  });

  // Shape bypasses — a different node for one of the three args, so ANCHORED never matches.
  test("rejects a block-body onGreenfield that plans then sends", async () => {
    const bypass =
      "await greenfieldOrSend(args.dir, STACK_ADAPTERS, async (d, s) => (await loadApprovedPlan(d, s.planSchema)) !== null, (stack) => { runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack); runSend(line); }, () => runSend(line))";

    expect(await countOn(wrapArrow(`${bypass};`))).toBe(0);
  });

  test("rejects a send chained onto runGreenfieldPlanning (.finally)", async () => {
    const bypass =
      "await greenfieldOrSend(args.dir, STACK_ADAPTERS, async (d, s) => (await loadApprovedPlan(d, s.planSchema)) !== null, (stack) => runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack).finally(() => runSend(line)), () => runSend(line))";

    expect(await countOn(wrapArrow(`${bypass};`))).toBe(0);
  });

  test("rejects a hasApprovedPlan predicate that sends", async () => {
    const bypass =
      "await greenfieldOrSend(args.dir, STACK_ADAPTERS, () => runSend(line).then(() => false), (stack) => runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack), () => runSend(line))";

    expect(await countOn(wrapArrow(`${bypass};`))).toBe(0);
  });

  // Code-vs-literal — a copy in a string/comment/template is not a call node.
  test("rejects string / comment / template copies of the exact call", async () => {
    expect(await countOn(`const a = ${JSON.stringify(CORRECT_CALL)};`)).toBe(0);
    expect(await countOn(`// ${CORRECT_CALL}`)).toBe(0);
    expect(await countOn("const b = `" + CORRECT_CALL + "`;")).toBe(0);
  });

  // Reachability / nesting — the call is present but is NOT the arrow's last statement, so the
  // handler still sends. Each is the class byte-level checks could not close.
  test("rejects a sequential trailing runSend after the correct call", async () => {
    expect(
      await countOn(wrapArrow(`${CORRECT_CALL};\n  await runSend(line);`))
    ).toBe(0);
  });

  test("rejects the correct call in an inner dead block with an outer send", async () => {
    expect(
      await countOn(
        wrapArrow(`if (false) { ${CORRECT_CALL}; }\n  await runSend(line);`)
      )
    ).toBe(0);
  });

  test("rejects an outer send BEFORE the correct call in an inner dead block (r15 bypass)", async () => {
    expect(
      await countOn(
        wrapArrow(`await runSend(line);\n  if (false) { ${CORRECT_CALL}; };`)
      )
    ).toBe(0);
  });

  test("rejects the correct call in a try whose finally sends", async () => {
    expect(
      await countOn(
        wrapArrow(`try { ${CORRECT_CALL}; } finally { await runSend(line); }`)
      )
    ).toBe(0);
  });

  test("rejects the correct call nested in an inner arrow with an outer send", async () => {
    expect(
      await countOn(
        wrapArrow(
          `const inner = async () => { ${CORRECT_CALL}; };\n  await runSend(line);`
        )
      )
    ).toBe(0);
  });

  // DOCUMENTED LIMIT (pinned so the boundary is explicit, not silent): a send BEFORE the call is
  // NOT rejected — the call is still the arrow's last statement. This is inherent: the real
  // handler has conditional runSend in earlier return-guarded branches, so a preceding send can't
  // be blanket-rejected without control-flow analysis. It is NOT covered by the greenfieldOrSend
  // behavioral test either (that test cannot see a send the caller runs before invoking it) — only
  // the real build/e2e path, which runs the actual handler, exercises this ordering.
  test("does NOT reject a preceding send (documented static-analysis limit)", async () => {
    expect(
      await countOn(wrapArrow(`await runSend(line);\n  ${CORRECT_CALL};`))
    ).toBe(1);
  });
});

// The multi-adapter planning claim: runGreenfieldPlanning must plan through the RESOLVED
// adapter's schema (`stack.planSchema`), not a hardcoded boringstack schema.
const SCHEMA_WIRING = "proposePlan($$$A, $$$B, stack.planSchema, $$$C)";

describe("runGreenfieldPlanning plans through the RESOLVED adapter's schema (ast-grep guard)", () => {
  test("the real proposePlan call passes stack.planSchema (the resolved adapter's)", () => {
    expect(countMatches(SCHEMA_WIRING, REPL_TS)).toBe(1);
  });

  test("SANITY: the resolved-schema call shape matches (so the negative fails for the right reason)", async () => {
    const ok = "proposePlan(deps, input, stack.planSchema, constraints);";

    expect(await countOnPat(SCHEMA_WIRING, ok)).toBe(1);
  });

  test("rejects a proposePlan call that hardcodes a concrete schema (the seam-bypass regression)", async () => {
    const hardcoded =
      "proposePlan(deps, input, boringstackPlanSchema, constraints);";

    expect(await countOnPat(SCHEMA_WIRING, hardcoded)).toBe(0);
  });
});
