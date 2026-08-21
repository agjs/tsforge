import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewFindingsToDrafts } from "../src/cli/repl";
import {
  normalizePlanDraft,
  persistPlanDocument,
  loadPlan,
} from "../src/loop/worklist";
import type { IPlanDocument } from "../src/loop/worklist";
import type { IReviewReport } from "../src/loop";

function report(over: Partial<IReviewReport> = {}): IReviewReport {
  return {
    base: "HEAD",
    changedFiles: ["a.ts"],
    findings: [],
    rejected: 0,
    ...over,
  };
}

const finding = (
  over: Partial<IReviewReport["findings"][number]> = {}
): IReviewReport["findings"][number] => ({
  file: "a.ts",
  line: 10,
  severity: "warning",
  lens: "review",
  claim: "a claim",
  reason: "the reason",
  verified: true,
  verdict: "reviewed",
  ...over,
});

test("one draft per finding: title=claim, files=[file], kind=modify", () => {
  const drafts = reviewFindingsToDrafts(
    report({
      findings: [finding({ file: "src/x.ts", line: 3, claim: "off-by-one" })],
    })
  );

  expect(drafts).toHaveLength(1);
  expect(drafts[0]).toMatchObject({
    title: "off-by-one",
    files: ["src/x.ts"],
    kind: "modify",
  });
  // detail carries the grounding: file:line, lens, severity, and the reason.
  expect(drafts[0]?.detail).toContain("src/x.ts:3");
  expect(drafts[0]?.detail).toContain("the reason");
});

test("orders worst-severity first (error → warning → info)", () => {
  const drafts = reviewFindingsToDrafts(
    report({
      findings: [
        finding({ severity: "info", claim: "info one" }),
        finding({ severity: "error", claim: "error one" }),
        finding({ severity: "warning", claim: "warn one" }),
      ],
    })
  );

  expect(drafts.map((d) => d.title)).toEqual([
    "error one",
    "warn one",
    "info one",
  ]);
});

test("includes the suggested fix in detail only when present", () => {
  const [withFix, withoutFix] = reviewFindingsToDrafts(
    report({
      findings: [
        finding({ severity: "error", suggestedFix: "return a - b;" }),
        finding({ severity: "warning" }),
      ],
    })
  );

  expect(withFix?.detail).toContain("Suggested fix: return a - b;");
  expect(withoutFix?.detail).not.toContain("Suggested fix:");
});

// ── seedReviewFixPlan's store composition (create + append) ──────────────────
// Mirrors what the repl closure does: draft findings → normalizePlanDraft →
// persist; then APPEND a second review's findings to the live plan, keeping its
// focus + done items. The closure needs a bound Session, so we drive the same
// store calls directly to lock the create/append behaviour.

let dir = "";

afterEach(() => {
  if (dir.length > 0) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

/** The repl closure's exact seeding step for a report → persisted plan. */
function seed(cwd: string, rep: IReviewReport): IPlanDocument {
  const goal = "Address code-review findings";
  const norm = normalizePlanDraft(
    { goal, items: reviewFindingsToDrafts(rep) },
    goal
  );

  if (!norm.ok) {
    throw new Error(norm.error);
  }

  return persistPlanDocument(cwd, norm.plan);
}

test("create: seeding a fresh review persists one open task per finding", () => {
  dir = mkdtempSync(join(tmpdir(), "tsforge-reviewfix-"));
  const plan = seed(
    dir,
    report({
      findings: [
        finding({ file: "a.ts", line: 1, severity: "error", claim: "one" }),
        finding({ file: "b.ts", line: 2, severity: "warning", claim: "two" }),
      ],
    })
  );

  const reloaded = loadPlan(dir, plan.id);

  expect(reloaded?.items).toHaveLength(2);
  expect(reloaded?.items.every((i) => i.status === "pending")).toBe(true);
  expect(reloaded?.activeItemId).toBeNull();
});

test("append: a second review adds tasks, keeping the active plan's focus + done items", () => {
  dir = mkdtempSync(join(tmpdir(), "tsforge-reviewfix-"));
  const first = seed(
    dir,
    report({ findings: [finding({ claim: "first finding" })] })
  );

  // Simulate the agent having focused + completed the first task, as the live
  // worklist would before a second /reviewfix appends more.
  const worked: IPlanDocument = {
    ...first,
    activeItemId: first.items[0]?.id ?? null,
    items: first.items.map((i) => ({ ...i, status: "done" })),
  };

  persistPlanDocument(dir, worked);

  // Second review → APPEND (the repl closure's else-branch).
  const norm = normalizePlanDraft(
    {
      goal: "Address code-review findings",
      items: reviewFindingsToDrafts(
        report({ findings: [finding({ claim: "second finding" })] })
      ),
    },
    "Address code-review findings"
  );

  if (!norm.ok) {
    throw new Error(norm.error);
  }

  const merged = persistPlanDocument(dir, {
    ...worked,
    items: [...worked.items, ...norm.plan.items],
  });
  const reloaded = loadPlan(dir, merged.id);

  expect(reloaded?.id).toBe(first.id); // same plan, extended
  expect(reloaded?.items).toHaveLength(2);
  expect(reloaded?.activeItemId).toBe(first.items[0]?.id ?? null); // focus kept
  expect(reloaded?.items[0]?.status).toBe("done"); // prior work kept
  expect(reloaded?.items[1]).toMatchObject({
    title: "second finding",
    status: "pending",
  });
  // No id collision — normalizePlanDraft assigns fresh ids.
  expect(reloaded?.items[0]?.id).not.toBe(reloaded?.items[1]?.id);
});
