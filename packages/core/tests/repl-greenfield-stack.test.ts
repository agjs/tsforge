import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { resolveGreenfieldStack, greenfieldConstraints } from "../src/cli/repl";
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

// The interception itself lives inside the REPL's readline line handler (a closure in
// `repl()`), which is not unit-reachable — the same class the /clear + --continue wiring is
// source-guarded for (see repl-ask-user-wiring.test.ts). Without this, removing the
// interception block or routing a greenfield line straight to runSend would leave every
// behavioral test above green. This locks that the dispatch is WIRED to the extracted seams.
describe("the REPL line handler is wired to the greenfield seams (source guard)", () => {
  test("dispatch calls resolveGreenfieldStack, routes to planning, and uses greenfieldConstraints", async () => {
    const src = await Bun.file(
      join(import.meta.dir, "..", "src", "cli", "repl.ts")
    ).text();

    // resolveGreenfieldStack appears TWICE — its definition AND its call in the line handler
    // (so a definition with no call would fail this).
    expect(
      (src.match(/resolveGreenfieldStack\(/g) ?? []).length
    ).toBeGreaterThanOrEqual(2);
    // A resolved stack routes into planning, not the normal send path.
    expect(src).toContain("runGreenfieldPlanning(");
    // …and the planner constraints come from the resolved adapter via greenfieldConstraints.
    expect(src).toContain("greenfieldConstraints(stack, echo)");
    // The registry the dispatch resolves against is the composition-root adapter list.
    expect(src).toContain("STACK_ADAPTERS");
  });
});
