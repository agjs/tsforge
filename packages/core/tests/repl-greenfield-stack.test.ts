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
  test("a detected+unplanned project runs onGreenfield with the EXACT stack, never onSend", async () => {
    const detected = stub("boringstack", true);
    const captured: { stack: IStackAdapter | null; sent: boolean } = {
      stack: null,
      sent: false,
    };

    await greenfieldOrSend(
      "/dir",
      [stub("other", false), detected],
      noApprovedPlan,
      (s) => {
        captured.stack = s;

        return Promise.resolve();
      },
      () => {
        captured.sent = true;

        return Promise.resolve();
      }
    );

    expect(captured.stack).toBe(detected);
    expect(captured.sent).toBe(false);
  });

  test("an undetected project runs onSend, never onGreenfield", async () => {
    let planned = false;
    let sent = false;

    await greenfieldOrSend(
      "/dir",
      [stub("a", false)],
      noApprovedPlan,
      () => {
        planned = true;

        return Promise.resolve();
      },
      () => {
        sent = true;

        return Promise.resolve();
      }
    );

    expect(sent).toBe(true);
    expect(planned).toBe(false);
  });

  test("a detected but ALREADY-planned project runs onSend, never onGreenfield", async () => {
    let planned = false;
    let sent = false;

    await greenfieldOrSend(
      "/dir",
      [stub("boringstack", true)],
      hasApprovedPlan,
      () => {
        planned = true;

        return Promise.resolve();
      },
      () => {
        sent = true;

        return Promise.resolve();
      }
    );

    expect(sent).toBe(true);
    expect(planned).toBe(false);
  });
});

// The remaining glue — the readline line handler CALLING greenfieldOrSend with the
// composition-root registry and the two real continuations — lives inside repl()'s readline
// closure, which is not unit-reachable (the same class the /clear + --continue wiring is
// source-guarded for; see repl-ask-user-wiring.test.ts). A SINGLE bound regex over
// comment-stripped source proves the pieces are wired TOGETHER (not independent presence
// probes): greenfieldOrSend(args.dir, STACK_ADAPTERS, <hasPlan>, <onGreenfield=…
// runGreenfieldPlanning…>, <onSend=…runSend(line)…>). Removing the interception or swapping a
// callback breaks the single match.
describe("the REPL line handler wires greenfieldOrSend (source guard)", () => {
  test("dispatch calls greenfieldOrSend with STACK_ADAPTERS and both real continuations", async () => {
    const raw = await Bun.file(
      join(import.meta.dir, "..", "src", "cli", "repl.ts")
    ).text();

    // Strip comments so a matching phrase in prose can't satisfy the guard.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    // One bound match: greenfieldOrSend(args.dir, STACK_ADAPTERS, … runGreenfieldPlanning …
    // runSend(line) …). The order (planning continuation before the send continuation) and
    // the shared call mean a define-but-never-call, wrong registry, or swapped branch fails.
    const wired =
      /greenfieldOrSend\(\s*args\.dir,\s*STACK_ADAPTERS,[\s\S]*?runGreenfieldPlanning\([\s\S]*?runSend\(line\)[\s\S]*?\)/;

    expect(src).toMatch(wired);
  });
});
