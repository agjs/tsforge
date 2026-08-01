import { test, expect, describe } from "bun:test";
import { join } from "node:path";
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
// composition-root registry and the two real continuations — lives inside repl()'s readline
// closure, which is not unit-reachable (the same class the /clear + --continue wiring is
// source-guarded for; see repl-ask-user-wiring.test.ts).
//
// SCOPE, stated honestly: this is a WIRING guard, NOT a purity proof. A regex cannot prove a
// continuation is side-effect-free — a determined author can always chain a send (`.finally`,
// `.then`, comma operator, …). What it CAN do is pin the EXACT current wiring shape, so any
// deviation — block body, a send chained onto runGreenfieldPlanning(...), a trailing send, a
// changed registry or arg list — fails the match and forces a reviewer to look. The SEMANTIC
// proof that the branch plans XOR sends is the greenfieldOrSend behavioral test above; this
// only guards that the handler actually routes through that branch with the real callbacks.
//
// WIRED pins the ENTIRE greenfieldOrSend call to its exact current shape — all three arguments,
// not just the two continuations. That is the honest endpoint for guarding a not-unit-reachable
// closure: rather than allow-variation-but-forbid-sends (a regex can't prove any callback is
// pure — a determined author chains a send onto ANY of the three), pin the exact wiring so ANY
// deviation (a changed hasPlan/onGreenfield/onSend, a chained or trailing send, a wrong registry)
// fails the match and forces a reviewer to look. Pins: greenfieldOrSend(args.dir, STACK_ADAPTERS,
// `async (d) => (await loadApprovedPlan(d)) !== null`, `(stack) => runGreenfieldPlanning(args.dir,
// line, echo, rl, activeModelEntry, stack)` terminated by `),`, `() => runSend(line)`, and the
// call as the handler's TERMINAL statement (`) ; }`). Semantic plan-XOR-send is proven by the
// greenfieldOrSend behavioral test above.
// `(?<![.\w])` anchors the callee: it must be a bare `greenfieldOrSend(`, not a member-call
// decoy like `shim.greenfieldOrSend(` or a word-prefixed name. (A regex over source can't
// exclude every conceivable decoy — a nested dead block or template-literal copy is out of
// scope; that is what the greenfieldOrSend BEHAVIORAL test covers.)
const WIRED =
  /(?<![.\w])greenfieldOrSend\(\s*args\.dir,\s*STACK_ADAPTERS,\s*async\s*\(d\)\s*=>\s*\(await loadApprovedPlan\(d\)\)\s*!==\s*null\s*,\s*\(stack\)\s*=>\s*runGreenfieldPlanning\(\s*args\.dir,\s*line,\s*echo,\s*rl,\s*activeModelEntry,\s*stack\s*\)\s*,\s*\(\)\s*=>\s*runSend\(line\)\s*\)\s*;\s*\}/;

/** Strip line + block comments so a matching phrase in prose can't satisfy the guard. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the REPL line handler wires greenfieldOrSend (source guard)", () => {
  test("the real handler source matches the exact wiring shape", async () => {
    const raw = await Bun.file(
      join(import.meta.dir, "..", "src", "cli", "repl.ts")
    ).text();

    expect(stripComments(raw)).toMatch(WIRED);
  });

  // Regression-test the guard's NEGATIVE guarantees in-file (not just out of band): each
  // plan-THEN-send bypass the reviewers raised must FAIL the same WIRED regex.
  test("the guard rejects a block-body onGreenfield that plans then sends", () => {
    const bypass =
      "greenfieldOrSend( args.dir, STACK_ADAPTERS, async (d) => (await loadApprovedPlan(d)) !== null, (stack) => { runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack); runSend(line); }, () => runSend(line) ); }";

    expect(stripComments(bypass)).not.toMatch(WIRED);
  });

  test("the guard rejects a send chained onto runGreenfieldPlanning (.finally)", () => {
    const bypass =
      "greenfieldOrSend( args.dir, STACK_ADAPTERS, async (d) => (await loadApprovedPlan(d)) !== null, (stack) => runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack).finally(() => runSend(line)), () => runSend(line) ); }";

    expect(stripComments(bypass)).not.toMatch(WIRED);
  });

  test("the guard rejects a bare runSend(line) trailing the greenfieldOrSend call", () => {
    const bypass =
      "greenfieldOrSend( args.dir, STACK_ADAPTERS, async (d) => (await loadApprovedPlan(d)) !== null, (stack) => runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack), () => runSend(line) ); await runSend(line); }";

    expect(stripComments(bypass)).not.toMatch(WIRED);
  });

  test("the guard rejects a hasApprovedPlan callback that sends (send-while-checking)", () => {
    // The plan-state predicate is pinned to its exact pure form, so a hasApprovedPlan that
    // sends — `() => runSend(line).then(() => false)` — no longer matches WIRED.
    const bypass =
      "greenfieldOrSend( args.dir, STACK_ADAPTERS, () => runSend(line).then(() => false), (stack) => runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack), () => runSend(line) ); }";

    expect(stripComments(bypass)).not.toMatch(WIRED);
  });

  test("the guard rejects a member-call decoy (shim.greenfieldOrSend) via the callee anchor", () => {
    // An otherwise-perfectly-shaped call on a DIFFERENT object must not satisfy the guard —
    // the `(?<![.\w])` anchor requires a bare `greenfieldOrSend(`, not `shim.greenfieldOrSend(`.
    const decoy =
      "shim.greenfieldOrSend( args.dir, STACK_ADAPTERS, async (d) => (await loadApprovedPlan(d)) !== null, (stack) => runGreenfieldPlanning(args.dir, line, echo, rl, activeModelEntry, stack), () => runSend(line) ); }";

    expect(stripComments(decoy)).not.toMatch(WIRED);
  });
});
