import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";
import { isChecklistSnapshot } from "../src/loop/harness-inject";
import {
  doTaskAdd,
  doTaskFocus,
  doTaskList,
} from "../src/loop/tools/task-tools";
import type { IToolContext } from "../src/loop/tools/tool-context";
import type { IPlanDocument } from "../src/loop/worklist/checklist.types";
import { savePlan } from "../src/loop/worklist/checklist-store";

function samplePlan(
  id: string,
  status: "pending" | "done" = "pending"
): IPlanDocument {
  return {
    schemaVersion: 2,
    id,
    goal: "Build notes CLI",
    activeItemId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    items: [
      { id: "a", title: "Create notes.ts", status },
      { id: "b", title: "Add tests", status },
    ],
  };
}

describe("checklist context", () => {
  test("multi-turn drive appends one snapshot and never touches the system message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-checklist-ctx-"));
    // Done items: green gate must not spin on checklistOpenNudge.
    const plan = samplePlan("plan-1", "done");

    savePlan(dir, plan);

    let fileSeq = 0;
    let pendingCreate = false;
    const provider: IProvider = {
      async complete() {
        if (!pendingCreate) {
          pendingCreate = true;
          fileSeq += 1;

          return {
            content: "",
            toolCalls: [
              {
                id: String(fileSeq),
                name: "create",
                arguments: {
                  file: `f${String(fileSeq)}.ts`,
                  content: `export const n = ${String(fileSeq)};\n`,
                },
              },
            ],
          };
        }

        pendingCreate = false;

        return { content: "done", toolCalls: [] };
      },
    };

    try {
      const session = await Session.create({
        provider,
        cwd: dir,
        files: ["**/*"],
        accept: "true",
        activePlanId: "plan-1",
        maxTurns: 4,
      });

      await session.send("first");
      await session.send("second");

      // The tree is APPENDED, never spliced into the system message: editing
      // index 0 discards the whole server-side prefix cache.
      const system = session.messages[0];

      expect(system?.role).toBe("system");
      // The heading appears in the HISTORY FRESHNESS rule as prose; the TREE
      // is what must never sit at index 0.
      expect(system?.content ?? "").not.toMatch(/^goal:/m);

      const snapshots = session.messages.filter((m) => isChecklistSnapshot(m));

      // An unchanged tree appends nothing, so a multi-turn drive holds exactly
      // one snapshot — the per-turn inject stays gone.
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.content ?? "").toContain("Create notes.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

test("task mutate tools return short ack; task_list returns tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-task-short-"));
  const plan = samplePlan("short");

  savePlan(dir, plan);

  const ctx: IToolContext = {
    cwd: dir,
    files: ["**/*"],
    report: () => undefined,
    task: "session",
    activePlanId: "short",
  };

  try {
    const focused = doTaskFocus({ id: "a" }, ctx);

    expect(focused).toContain("focused:");
    expect(focused).not.toContain("items:");

    const added = doTaskAdd({ title: "Extra work" }, ctx);

    expect(added.startsWith("added:")).toBe(true);
    expect(added).not.toContain("items:");

    const listed = doTaskList({}, ctx);

    expect(listed).toContain("items:");
    expect(listed).toContain("Extra work");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
