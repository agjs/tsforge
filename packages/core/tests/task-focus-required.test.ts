import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../src/loop/tools/execute-tool";
import type { IToolContext } from "../src/loop/tools/tool-context";
import { persistPlanDocument, normalizePlanDraft } from "../src/loop/worklist";
import { loadPlan } from "../src/loop/worklist/checklist-store";

function ctx(cwd: string, planId: string | null): IToolContext {
  return {
    cwd,
    files: ["**/*"],
    task: "t",
    report: () => undefined,
    ...(planId === null ? {} : { activePlanId: planId }),
  };
}

test("bound plan with no focus rejects edit; file unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-focus-"));

  try {
    await Bun.write(join(dir, "a.ts"), "export const n = 1;\n");
    const norm = normalizePlanDraft(
      { goal: "ship", items: [{ title: "Flap" }] },
      "ship"
    );

    expect(norm.ok).toBe(true);

    if (!norm.ok) {
      return;
    }

    const plan = persistPlanDocument(dir, norm.plan);
    const out = await executeTool(
      {
        name: "edit",
        arguments: {
          file: "a.ts",
          oldString: "export const n = 1;\n",
          newString: "export const n = 2;\n",
        },
      },
      ctx(dir, plan.id)
    );

    expect(out).toContain("task_focus");
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(
      "export const n = 1;\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("after task_focus the same edit applies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-focus-"));

  try {
    await Bun.write(join(dir, "a.ts"), "export const n = 1;\n");
    const norm = normalizePlanDraft(
      { goal: "ship", items: [{ title: "Flap" }] },
      "ship"
    );

    expect(norm.ok).toBe(true);

    if (!norm.ok) {
      return;
    }

    const plan = persistPlanDocument(dir, norm.plan);
    const toolCtx = ctx(dir, plan.id);
    const listed = await executeTool(
      { name: "task_list", arguments: {} },
      toolCtx
    );

    expect(listed).toContain("Flap");

    const itemId = loadPlan(dir, plan.id)?.items[0]?.id;

    expect(itemId).toBeString();

    const focused = await executeTool(
      { name: "task_focus", arguments: { id: itemId } },
      toolCtx
    );

    expect(focused.toLowerCase()).not.toContain("rejected");

    const out = await executeTool(
      {
        name: "edit",
        arguments: {
          file: "a.ts",
          oldString: "export const n = 1;\n",
          newString: "export const n = 2;\n",
        },
      },
      toolCtx
    );

    expect(out).not.toContain("task_focus");
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(
      "export const n = 2;\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unbound session still edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-focus-"));

  try {
    await Bun.write(join(dir, "a.ts"), "export const n = 1;\n");
    const out = await executeTool(
      {
        name: "edit",
        arguments: {
          file: "a.ts",
          oldString: "export const n = 1;\n",
          newString: "export const n = 2;\n",
        },
      },
      ctx(dir, null)
    );

    expect(out).not.toContain("task_focus");
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(
      "export const n = 2;\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
