import { test, expect, describe } from "bun:test";
import {
  isBoringstackProject,
  boringstackPlanConstraints,
  BORINGSTACK_PLANNER_GUIDANCE,
  BORINGSTACK_RESERVED_ENTITY_IDS,
} from "../src/loop/boringstack/planning";

describe("isBoringstackProject (authoritative scaffold-receipt detection)", () => {
  test("true only when the receipt records archetype boringstack", async () => {
    const read = async (): Promise<string> =>
      JSON.stringify({ archetype: "boringstack", source: "x" });

    expect(await isBoringstackProject("/proj", read)).toBe(true);
  });

  test("false for a DIFFERENT archetype (e.g. astro)", async () => {
    const read = async (): Promise<string> =>
      JSON.stringify({ archetype: "astro" });

    expect(await isBoringstackProject("/proj", read)).toBe(false);
  });

  test("false when there is no receipt — a generic monorepo is NOT boringstack", async () => {
    // A random apps/api + apps/ui + infra/compose repo has no tsforge receipt, so
    // it is never force-planned as boringstack (no false positive, no lost User).
    const read = async (): Promise<string> => {
      throw new Error("ENOENT");
    };

    expect(await isBoringstackProject("/proj", read)).toBe(false);
  });

  test("false when the receipt is malformed JSON", async () => {
    const read = async (): Promise<string> => "not json";

    expect(await isBoringstackProject("/proj", read)).toBe(false);
  });
});

describe("boringstackPlanConstraints", () => {
  test("carries the BoringStack guidance + reserved set", () => {
    const c = boringstackPlanConstraints(() => undefined);

    expect(c.guidance).toBe(BORINGSTACK_PLANNER_GUIDANCE);
    expect(c.reservedEntities).toBe(BORINGSTACK_RESERVED_ENTITY_IDS);
  });

  test("plumbs the onStripped reporter through (drops are never silent)", () => {
    const seen: string[][] = [];
    const c = boringstackPlanConstraints((ids) => seen.push([...ids]));

    c.onStripped?.(["User", "Login"]);

    expect(seen).toEqual([["User", "Login"]]);
  });

  test("the reserved set is pure-auth only — keeps ambiguous domain nouns", () => {
    for (const kept of ["account", "session", "profile", "credential"]) {
      expect(BORINGSTACK_RESERVED_ENTITY_IDS.has(kept)).toBe(false);
    }

    for (const reserved of ["user", "users", "auth", "login", "signup"]) {
      expect(BORINGSTACK_RESERVED_ENTITY_IDS.has(reserved)).toBe(true);
    }
  });
});
