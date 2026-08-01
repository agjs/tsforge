import { test, expect, describe } from "bun:test";
import { isProductPlan } from "../src/loop/planning/plan-store";
import { isRecord } from "../src/lib/guards";

// Proves core validates the STRUCTURAL SPINE only and DEFERS the UI shape + any cross-slice rule to
// the INJECTED schema — with a NON-BoringStack (game-shaped) UI intent. If core still carried a
// hardcoded web UI check (screens/nav/…), the game plans below would be rejected and this test
// would fail; if it ignored the injected validateUi, the malformed-ui plan would be accepted.
interface IGameUi {
  readonly scene: string;
}

const isGameUi = (v: unknown): v is IGameUi =>
  isRecord(v) && typeof v.scene === "string";

// A non-web cross-slice rule: at most two scenes (nothing to do with "home").
const atMostTwoScenes = (plan: {
  slices: readonly { ui: IGameUi }[];
}): boolean => plan.slices.length <= 2;

const entity = {
  id: "Level",
  desc: "d",
  fields: [],
  relationships: [],
  rules: [],
};
const verification = {
  mustRemainTrue: [],
  mustNotHappen: ["x"],
  acceptanceCheck: "x",
};
const gameSlice = (scene: string): unknown => ({
  entity,
  ui: { scene },
  verification,
});
const webSlice = (): unknown => ({
  entity,
  ui: { screens: ["list"], action: "a", shows: [], nav: "N" }, // valid WEB ui, invalid GAME ui
  verification,
});

describe("core plan validation defers UI + cross-slice rules to the injected schema", () => {
  test("accepts a plan whose ui matches the injected (game) validator", () => {
    expect(
      isProductPlan({ product: "g", slices: [gameSlice("a")] }, isGameUi)
    ).toBe(true);
  });

  test("REJECTS a web-shaped ui under the game validator (no hardcoded web check in core)", () => {
    expect(
      isProductPlan({ product: "g", slices: [webSlice()] }, isGameUi)
    ).toBe(false);
  });

  test("enforces the injected cross-slice extraCheck (not the boringstack '≤1 home' rule)", () => {
    const two = { product: "g", slices: [gameSlice("a"), gameSlice("b")] };
    const three = {
      product: "g",
      slices: [gameSlice("a"), gameSlice("b"), gameSlice("c")],
    };

    expect(isProductPlan(two, isGameUi, atMostTwoScenes)).toBe(true);
    expect(isProductPlan(three, isGameUi, atMostTwoScenes)).toBe(false);
  });

  test("still validates the STRUCTURAL spine (a slice missing verification is rejected)", () => {
    const bad = { product: "g", slices: [{ entity, ui: { scene: "a" } }] };

    expect(isProductPlan(bad, isGameUi)).toBe(false);
  });
});
