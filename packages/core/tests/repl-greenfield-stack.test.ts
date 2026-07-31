import { test, expect, describe } from "bun:test";
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
