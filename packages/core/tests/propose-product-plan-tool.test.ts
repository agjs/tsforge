import { test, expect, describe } from "bun:test";
import { doProposeProductPlan } from "../src/loop/tools/propose-product-plan-tool";
import type { IToolContext } from "../src/loop/tools/tool-context";
import type { IProductPlan } from "../src/loop/planning/plan-types";

const FIXTURE_PLAN: IProductPlan = {
  product: "a bookmarking app",
  slices: [
    {
      entity: {
        id: "Bookmark",
        desc: "a link",
        fields: [{ name: "url", type: "string" }],
        relationships: [],
        rules: [],
      },
      ui: {},
      verification: {
        mustRemainTrue: ["auth"],
        mustNotHappen: ["no url"],
        acceptanceCheck: "bun test",
      },
    },
  ],
};

function ctx(overrides: Partial<IToolContext> = {}): IToolContext {
  return {
    cwd: "/tmp",
    files: ["**/*"],
    task: "session",
    report: () => undefined,
    ...overrides,
  };
}

describe("doProposeProductPlan", () => {
  test("refuses outside greenfield planning (no productPlanValidate wired)", async () => {
    const result = await doProposeProductPlan(
      { product: "x", slices: [] },
      ctx()
    );

    expect(result).toMatch(/greenfield/i);
  });

  test("validates, notifies onProductPlanProposed, does not write disk itself", async () => {
    const proposed: IProductPlan[] = [];
    const result = await doProposeProductPlan(
      { product: "a bookmarking app", slices: [] },
      ctx({
        productPlanValidate: () => ({ ok: true, plan: FIXTURE_PLAN }),
        onProductPlanProposed: (plan) => {
          proposed.push(plan);
        },
      })
    );

    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.product).toBe("a bookmarking app");
    expect(result).toMatch(/proposed/i);
    expect(result).toMatch(/Do NOT paste/i);
    expect(result).toMatch(/approve/i);
  });

  test("awaits an async onProductPlanProposed before returning", async () => {
    let settled = false;
    const result = await doProposeProductPlan(
      { product: "x", slices: [] },
      ctx({
        productPlanValidate: () => ({ ok: true, plan: FIXTURE_PLAN }),
        onProductPlanProposed: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          settled = true;
        },
      })
    );

    expect(settled).toBe(true);
    expect(result).toMatch(/proposed/i);
  });

  test("rejects with the validator's error and never calls onProductPlanProposed", async () => {
    let called = false;
    const result = await doProposeProductPlan(
      { product: "x", slices: [] },
      ctx({
        productPlanValidate: () => ({
          ok: false,
          error: "invalid ui shape for slice Bookmark",
        }),
        onProductPlanProposed: () => {
          called = true;
        },
      })
    );

    expect(result).toBe("invalid ui shape for slice Bookmark");
    expect(called).toBe(false);
  });
});
