import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/loop/session";
import type { IProvider } from "../src/inference";
import { persistPlanDocument, normalizePlanDraft } from "../src/loop/worklist";

function captureTools(): { names: string[]; provider: IProvider } {
  const names: string[] = [];

  return {
    names,
    provider: {
      async complete(_messages, opts) {
        const tools = Array.isArray(opts?.tools) ? opts.tools : [];

        names.length = 0;

        for (const t of tools) {
          if (typeof t !== "object" || t === null || !("function" in t)) {
            continue;
          }

          const fn = t.function;

          if (
            typeof fn === "object" &&
            fn !== null &&
            "name" in fn &&
            typeof fn.name === "string"
          ) {
            names.push(fn.name);
          }
        }

        return { content: "ok", toolCalls: [] };
      },
    },
  };
}

test("interactive:false + copilot flags advertise present_plan in plan mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-copilot-"));
  const cap = captureTools();

  try {
    const session = await Session.create({
      provider: cap.provider,
      cwd: dir,
      files: ["**/*"],
      interactive: false,
      humanPresent: true,
      offerTaskTools: true,
      offerPresentPlan: true,
    });

    session.setPlanMode(true);
    await session.send("plan a game");

    expect(cap.names).toContain("present_plan");
    expect(cap.names).toContain("ask_user");
    expect(cap.names).not.toContain("task_focus");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("after bind, task_focus is advertised; present_plan is not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-copilot-"));
  const cap = captureTools();

  try {
    const norm = normalizePlanDraft(
      { goal: "ship", items: [{ title: "Flap" }] },
      "ship"
    );

    expect(norm.ok).toBe(true);

    if (!norm.ok) {
      return;
    }

    const plan = persistPlanDocument(dir, norm.plan);
    const session = await Session.create({
      provider: cap.provider,
      cwd: dir,
      files: ["**/*"],
      interactive: false,
      humanPresent: true,
      offerTaskTools: true,
      offerPresentPlan: true,
      activePlanId: plan.id,
    });

    session.setPlanMode(false);
    await session.send("implement");

    expect(cap.names).toContain("task_focus");
    expect(cap.names).toContain("task_list");
    expect(cap.names).not.toContain("present_plan");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interactive:false without copilot flags still withholds present_plan and task_*", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-copilot-"));
  const cap = captureTools();

  try {
    const session = await Session.create({
      provider: cap.provider,
      cwd: dir,
      files: ["**/*"],
      interactive: false,
    });

    session.setPlanMode(true);
    await session.send("hi");

    expect(cap.names).not.toContain("present_plan");
    expect(cap.names).not.toContain("task_focus");
    expect(cap.names).not.toContain("ask_user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
