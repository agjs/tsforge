import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
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
// executable code from a string / comment / template / unreachable-block copy of the same shape;
// the reviewers demonstrated each such class in turn. So this guard matches the AST STRUCTURALLY
// via ast-grep (the repo's own tool — see loop/astgrep-fix.ts): the pattern matches ONLY a real
// `await greenfieldOrSend(...)` CALL-EXPRESSION node — a string/comment/template copy is simply
// not a call node and can never satisfy it. Semantic plan-XOR-send is proven by the
// greenfieldOrSend behavioral test above; this proves the handler routes through that branch
// with the real registry and continuations.
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

/** The `text` of an ast-grep JSON match node, read without an `as` cast (house rule). */
const matchText = (m: unknown): string =>
  m !== null &&
  typeof m === "object" &&
  "text" in m &&
  typeof m.text === "string"
    ? m.text
    : "";

/** Structurally match `pattern` over repl.ts via ast-grep, returning each matched code node's
 *  text. Because it matches the AST, string / comment / template / prose copies (which are NOT
 *  call-expression nodes) can never match — the class no source regex could exclude. */
const astMatches = (pattern: string): string[] => {
  const proc = Bun.spawnSync([
    AST_GREP,
    "run",
    "-p",
    pattern,
    "-l",
    "ts",
    "--json",
    REPL_TS,
  ]);

  if (proc.exitCode !== 0) {
    throw new Error(`ast-grep failed: ${proc.stderr.toString()}`);
  }

  const parsed: unknown = JSON.parse(proc.stdout.toString());

  return Array.isArray(parsed) ? parsed.map(matchText) : [];
};

describe("the REPL line handler wires greenfieldOrSend (ast-grep structural guard)", () => {
  test("ast-grep is available — the guard must not silently vanish", () => {
    expect(existsSync(AST_GREP)).toBe(true);
  });

  test("exactly one real greenfieldOrSend(args.dir, STACK_ADAPTERS, …) CALL NODE is wired", () => {
    const matches = astMatches(
      "await greenfieldOrSend(args.dir, STACK_ADAPTERS, $$$REST)"
    );

    // Exactly ONE real call node. A string/comment/template copy is not a call node, so it can
    // neither inflate this count nor stand in for a deleted real call (the whole decoy class the
    // reviewers raised — string, comment, template — is closed at the AST level).
    expect(matches.length).toBe(1);

    // The matched region is REAL code, so text checks WITHIN it are immune to the decoy class:
    // both continuations are wired — the branch plans via runGreenfieldPlanning and, for a
    // non-detected/already-planned project, sends via runSend(line). Plan-XOR-send SEMANTICS are
    // proven by the greenfieldOrSend behavioral test; this pins the real wiring.
    const call = matches.join("");

    expect(call).toContain("runGreenfieldPlanning(");
    expect(call).toContain("runSend(line)");
  });
});
