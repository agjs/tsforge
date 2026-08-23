import { test, expect } from "bun:test";
import {
  plannerSliceIds,
  productPlanToDraft,
} from "../src/loop/planning/product-plan-ui";
import { normalizePlanDraft } from "../src/loop/worklist";
import { formatPlanProposal } from "../src/loop/worklist/panel";
import { PLANNER_EXAMPLE } from "../src/loop/phaser/plan-extension";

test("productPlanToDraft is titles and details, not a JSON blob of ui", () => {
  const draft = productPlanToDraft(PLANNER_EXAMPLE);

  expect(draft.goal).toContain("flap");
  expect(draft.items[0]?.title).toBe("Flap");
  expect(draft.items[0]?.detail).toContain("Gravity");
  expect(draft.items[0]?.detail).not.toContain("feature");
  expect(JSON.stringify(draft)).not.toContain('"mustRemainTrue"');
});

test("the PLAN card paints Flap, not the raw product-plan JSON", () => {
  const draft = productPlanToDraft(PLANNER_EXAMPLE);
  const norm = normalizePlanDraft(draft, PLANNER_EXAMPLE.product);

  expect(norm.ok).toBe(true);

  if (!norm.ok) {
    return;
  }

  const card = formatPlanProposal(norm.plan, 80, false);

  expect(card).toContain("PLAN");
  expect(card).toContain("Flap");
  expect(card).toContain("Pipes");
  expect(card).not.toContain("Bird");
  expect(card).toContain("type approve to build");
  expect(card).not.toContain('"slices"');
  expect(card).not.toContain("mustRemainTrue");
});

test("plannerSliceIds reads entity ids out of streaming JSON, not the raw blob", () => {
  const raw = JSON.stringify(PLANNER_EXAMPLE);

  expect(plannerSliceIds(raw)).toEqual(["Flap", "Pipes", "Crash", "Score"]);
  expect(plannerSliceIds(raw.slice(0, 40))).toEqual([]);
});
