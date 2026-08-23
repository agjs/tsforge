import { test, expect } from "bun:test";
import { productPlanToDraft } from "../src/loop/planning/product-plan-ui";
import { normalizePlanDraft } from "../src/loop/worklist";
import { formatPlanProposal } from "../src/loop/worklist/panel";
import { PLANNER_EXAMPLE } from "../src/loop/phaser/plan-extension";

test("productPlanToDraft is titles and details, not a JSON blob of ui", () => {
  const draft = productPlanToDraft(PLANNER_EXAMPLE);

  expect(draft.goal).toContain("grid adventure");
  expect(draft.items[0]?.title).toBe("Coin");
  expect(draft.items[0]?.detail).toContain("collectible");
  expect(draft.items[0]?.detail).toContain("feature");
  expect(JSON.stringify(draft)).not.toContain('"mustRemainTrue"');
});

test("the PLAN card paints Coin, not the raw product-plan JSON", () => {
  const draft = productPlanToDraft(PLANNER_EXAMPLE);
  const norm = normalizePlanDraft(draft, PLANNER_EXAMPLE.product);

  expect(norm.ok).toBe(true);

  if (!norm.ok) {
    return;
  }

  const card = formatPlanProposal(norm.plan, 80, false);

  expect(card).toContain("PLAN");
  expect(card).toContain("Coin");
  expect(card).toContain("type approve to build");
  expect(card).not.toContain('"slices"');
  expect(card).not.toContain("mustRemainTrue");
});
