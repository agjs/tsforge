import { test, expect, describe } from "bun:test";
import {
  isBoringstackUiIntent,
  boringstackUiFields,
  boringstackPlanSchema,
  boringstackPlanSchemaErased,
  PLANNER_EXAMPLE,
  IMPLEMENTED_LAYOUT_ARCHETYPES,
  type IUiIntent,
} from "../src/loop/boringstack/plan-extension";

const validUi: IUiIntent = {
  screens: ["list", "form"],
  action: "add",
  shows: ["title"],
  nav: "Tasks",
};

describe("isBoringstackUiIntent", () => {
  test("accepts a well-formed web UI intent", () => {
    expect(isBoringstackUiIntent(validUi)).toBe(true);
  });

  test("rejects an unknown screen id", () => {
    expect(isBoringstackUiIntent({ ...validUi, screens: ["carousel"] })).toBe(
      false
    );
  });

  test("rejects an empty action / nav", () => {
    expect(isBoringstackUiIntent({ ...validUi, action: "" })).toBe(false);
    expect(isBoringstackUiIntent({ ...validUi, nav: "" })).toBe(false);
  });

  test("rejects a layout that is not IMPLEMENTED (roadmap-only is rejected, not mis-built)", () => {
    for (const layout of ["public", "app-topnav", "focused"]) {
      expect(isBoringstackUiIntent({ ...validUi, layout })).toBe(false);
    }

    for (const layout of IMPLEMENTED_LAYOUT_ARCHETYPES) {
      expect(isBoringstackUiIntent({ ...validUi, layout })).toBe(true);
    }
  });

  test("rejects a non-boolean home", () => {
    expect(isBoringstackUiIntent({ ...validUi, home: "true" })).toBe(false);
    expect(isBoringstackUiIntent({ ...validUi, home: true })).toBe(true);
  });
});

const entity = {
  id: "X",
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
const homeSlice = (home: boolean) => ({
  entity,
  ui: { ...validUi, home },
  verification,
});
const plan = (
  slices: readonly ReturnType<typeof homeSlice>[]
): { product: string; slices: readonly ReturnType<typeof homeSlice>[] } => ({
  product: "p",
  slices,
});

describe("boringstackPlanSchema.extraCheck (≤1 home)", () => {
  test("accepts zero or one home slice, rejects two", () => {
    expect(
      boringstackPlanSchema.extraCheck?.(
        plan([homeSlice(false), homeSlice(false)])
      )
    ).toBe(true);
    expect(
      boringstackPlanSchema.extraCheck?.(
        plan([homeSlice(true), homeSlice(false)])
      )
    ).toBe(true);
    expect(
      boringstackPlanSchema.extraCheck?.(
        plan([homeSlice(true), homeSlice(true)])
      )
    ).toBe(false);
  });
});

describe("boringstackPlanSchemaErased (type-erased parity)", () => {
  test("its extraCheck returns the SAME verdict as the typed schema on every valid plan", () => {
    // Both schemas' extraCheck call the SAME boringstackAtMostOneHome helper, so they can never
    // drift. Prove it: on each valid plan the typed and erased verdicts are identical.
    const cases = [
      plan([homeSlice(false), homeSlice(false)]), // 0 homes → true
      plan([homeSlice(true), homeSlice(false)]), // 1 home  → true
      plan([homeSlice(true), homeSlice(true)]), // 2 homes → false
    ];

    for (const p of cases) {
      const typed = boringstackPlanSchema.extraCheck?.(p);

      expect(boringstackPlanSchemaErased.extraCheck?.(p)).toBe(typed);
    }
  });

  test("a slice whose ui is not a valid intent contributes no home (the documented divergence case)", () => {
    // The one input the typed extraCheck can't be TYPED to receive (invalid ui): { home: true }
    // with no screens is NOT a valid IUiIntent. The shared helper re-narrows with
    // isBoringstackUiIntent, so it counts as NO home — a plan pairing one real home with such an
    // invalid-ui slice stays ≤1 home (true). This is where the two bodies used to be able to
    // diverge; sharing the helper removes the risk.
    const invalidHomeSlice = { entity, ui: { home: true }, verification };

    expect(
      boringstackPlanSchemaErased.extraCheck?.({
        product: "p",
        slices: [homeSlice(true), invalidHomeSlice],
      })
    ).toBe(true);
    expect(
      boringstackPlanSchemaErased.extraCheck?.({
        product: "p",
        slices: [homeSlice(true), homeSlice(true)],
      })
    ).toBe(false);
  });

  test("validateUi is the boringstack guard", () => {
    expect(boringstackPlanSchemaErased.validateUi(validUi)).toBe(true);
    expect(boringstackPlanSchemaErased.validateUi({ nope: 1 })).toBe(false);
  });
});

describe("boringstackUiFields", () => {
  test("extracts nav / shows / screens from a UI intent", () => {
    const first = PLANNER_EXAMPLE.slices[0];

    if (!first) {
      throw new Error("PLANNER_EXAMPLE has no slice");
    }

    expect(boringstackUiFields(first.ui)).toEqual({
      nav: "Tasks",
      shows: ["title", "done", "dueDate"],
      screens: ["list", "detail", "form"],
    });
  });
});
