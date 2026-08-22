import { test, expect } from "bun:test";
import {
  isPhaserViewIntent,
  phaserPlanSchema,
  PLANNER_EXAMPLE,
} from "../src/loop/phaser/plan-extension";
import { isProductPlan } from "../src/loop/planning/plan-store";
import { parsePlanJson } from "../src/loop/planning/propose-plan";

test("PLANNER_EXAMPLE is a valid Phaser product plan", () => {
  expect(
    isProductPlan(
      PLANNER_EXAMPLE,
      isPhaserViewIntent,
      phaserPlanSchema.extraCheck
    )
  ).toBe(true);
  expect(isPhaserViewIntent(PLANNER_EXAMPLE.slices[0]?.ui)).toBe(true);
});

test("a BoringStack-shaped ui is rejected", () => {
  expect(
    isPhaserViewIntent({
      screens: ["list"],
      action: "save",
      shows: ["title"],
      nav: "Tasks",
    })
  ).toBe(false);
});

test("kind feature requires a feature folder name", () => {
  expect(isPhaserViewIntent({ kind: "feature", scene: "World" })).toBe(false);
  expect(
    isPhaserViewIntent({ kind: "feature", scene: "World", feature: "coin" })
  ).toBe(true);
});

test("kind content requires a catalog", () => {
  expect(isPhaserViewIntent({ kind: "content", scene: "World" })).toBe(false);
  expect(
    isPhaserViewIntent({
      kind: "content",
      scene: "World",
      catalog: "items",
    })
  ).toBe(true);
});

test("parsePlanJson accepts the example JSON and rejects a screens plan", () => {
  expect(
    parsePlanJson(JSON.stringify(PLANNER_EXAMPLE), isPhaserViewIntent)
  ).not.toBeNull();
  expect(
    parsePlanJson(
      JSON.stringify({
        product: "A task app.",
        slices: [
          {
            entity: {
              id: "Task",
              desc: "a task",
              fields: [{ name: "title", type: "string" }],
              relationships: [],
              rules: [],
            },
            ui: {
              screens: ["list"],
              action: "create",
              shows: ["title"],
              nav: "Tasks",
            },
            verification: {
              mustRemainTrue: ["a"],
              mustNotHappen: ["b"],
              acceptanceCheck: "bun test",
            },
          },
        ],
      }),
      isPhaserViewIntent
    )
  ).toBeNull();
});
