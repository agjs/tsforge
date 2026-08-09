import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeItemInPlan,
  focusItemInPlan,
  isChecklistComplete,
  loadPlan,
  savePlan,
  uncompleteItemInPlan,
} from "../src/loop/worklist/checklist-store";
import type { IPlanDocument } from "../src/loop/worklist/checklist.types";
import {
  doTaskComplete,
  doTaskFocus,
  doTaskList,
} from "../src/loop/tools/task-tools";
import type { IToolContext } from "../src/loop/tools/tool-context";

function samplePlan(id: string): IPlanDocument {
  return {
    schemaVersion: 2,
    id,
    goal: "ship",
    activeItemId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    items: [
      {
        id: "parent",
        title: "Parent",
        status: "pending",
        children: [
          { id: "child-a", title: "Child A", status: "pending" },
          { id: "child-b", title: "Child B", status: "pending" },
        ],
      },
    ],
  };
}

describe("checklist-store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-plan-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("refuses parent complete while children open; auto-completes parent", () => {
    let plan = samplePlan("p1");
    const refuse = completeItemInPlan(plan, "parent");

    expect(refuse.ok).toBe(false);

    const a = completeItemInPlan(plan, "child-a");

    expect(a.ok).toBe(true);

    if (!a.ok) {
      return;
    }

    plan = a.plan;
    const b = completeItemInPlan(plan, "child-b");

    expect(b.ok).toBe(true);

    if (!b.ok) {
      return;
    }

    expect(b.plan.items[0]?.status).toBe("done");
    expect(isChecklistComplete(b.plan)).toBe(true);
  });

  test("focus + uncomplete persist via tools scoped to activePlanId", async () => {
    const plan = samplePlan("bound");
    savePlan(dir, plan);

    const reports: string[] = [];
    const ctx: IToolContext = {
      cwd: dir,
      files: ["**/*"],
      report: (e) => {
        if (e.kind === "tool" && typeof e.message === "string") {
          reports.push(e.message);
        }
      },
      task: "session",
      activePlanId: "bound",
      runCheck: async () => ({
        passed: true,
        errors: [],
        output: "",
        autoFixed: [],
      }),
    };

    expect(doTaskList({}, ctx)).toContain("Parent");

    const focused = doTaskFocus({ id: "child-a" }, ctx);

    expect(focused).toContain("focused:");
    expect(loadPlan(dir, "bound")?.activeItemId).toBe("child-a");

    await doTaskComplete({ id: "child-a" }, ctx);
    expect(loadPlan(dir, "bound")?.items[0]?.children?.[0]?.status).toBe(
      "done"
    );
    expect(reports.some((m) => m.startsWith("task_complete:"))).toBe(true);

    const other: IToolContext = { ...ctx, activePlanId: "missing" };

    expect(doTaskList({}, other)).toMatch(/no active plan|missing/i);
  });

  test("task_complete refuses when gate is red — item stays open", async () => {
    const plan = samplePlan("red");
    savePlan(dir, plan);

    const ctx: IToolContext = {
      cwd: dir,
      files: ["**/*"],
      report: () => undefined,
      task: "session",
      activePlanId: "red",
      runCheck: async () => ({
        passed: false,
        errors: [{ key: "x", message: "TS2304: Cannot find name 'x'" }],
        output: "fail",
        autoFixed: [],
      }),
    };

    const out = await doTaskComplete({ id: "child-a" }, ctx);

    expect(out).toMatch(/gate RED/i);
    expect(loadPlan(dir, "red")?.items[0]?.children?.[0]?.status).toBe(
      "pending"
    );
  });

  test("task_complete refuses when no gate is wired", async () => {
    const plan = samplePlan("nogate");
    savePlan(dir, plan);

    const ctx: IToolContext = {
      cwd: dir,
      files: ["**/*"],
      report: () => undefined,
      task: "session",
      activePlanId: "nogate",
    };

    const out = await doTaskComplete({ id: "child-a" }, ctx);

    expect(out).toMatch(/no gate/i);
    expect(loadPlan(dir, "nogate")?.items[0]?.children?.[0]?.status).toBe(
      "pending"
    );
  });

  test("focus/uncomplete helpers", () => {
    let plan = samplePlan("p2");
    const focused = focusItemInPlan(plan, "child-b");

    expect(focused.ok).toBe(true);

    if (!focused.ok) {
      return;
    }

    plan = focused.plan;
    expect(plan.activeItemId).toBe("child-b");

    const done = completeItemInPlan(plan, "child-b");

    expect(done.ok).toBe(true);

    if (!done.ok) {
      return;
    }

    const undone = uncompleteItemInPlan(done.plan, "child-b");

    expect(undone.ok).toBe(true);

    if (!undone.ok) {
      return;
    }

    expect(undone.plan.items[0]?.children?.[1]?.status).toBe("pending");
  });
});
