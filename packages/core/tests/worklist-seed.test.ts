import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPlanJson,
  seedWorklistFromPlan,
  goalFromMessages,
} from "../src/loop/worklist/seed";
import { loadPlan, loadPlanIndex } from "../src/loop/worklist/checklist-store";

describe("extractPlanJson", () => {
  test("takes the first parseable fenced json block", () => {
    const md = `# Intro\n\n\`\`\`json\n{"goal":"g","items":[{"title":"One"}]}\n\`\`\`\n\n## Later\n`;

    expect(extractPlanJson(md)).toEqual({
      goal: "g",
      items: [{ title: "One" }],
    });
  });
});

describe("seedWorklistFromPlan", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-seed-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes plans/<id>.json + index from fenced JSON", () => {
    const result = seedWorklistFromPlan(
      dir,
      [
        "## Plan",
        "",
        "```json",
        JSON.stringify({
          goal: "ship checklist",
          items: [
            {
              title: "Add parser",
              detail: "nested ok",
              children: [{ title: "Wire rail", verify: "bun test" }],
            },
          ],
        }),
        "```",
      ].join("\n"),
      "fallback"
    );

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.plan.goal).toBe("ship checklist");
    expect(result.plan.schemaVersion).toBe(2);
    expect(result.plan.items).toHaveLength(1);
    expect(result.plan.items[0]?.title).toBe("Add parser");
    expect(result.plan.items[0]?.children?.[0]?.title).toBe("Wire rail");
    expect(result.plan.items[0]?.children?.[0]?.verify).toBe("bun test");
    expect(result.plan.items[0]?.id.length).toBeGreaterThan(0);

    const onDisk = loadPlan(dir, result.plan.id);

    expect(onDisk?.id).toBe(result.plan.id);
    expect(loadPlanIndex(dir).plans.some((p) => p.id === result.plan.id)).toBe(
      true
    );
  });

  test("two seeds create two plan files (no clobber)", () => {
    const a = seedWorklistFromPlan(
      dir,
      '```json\n{"goal":"a","items":[{"title":"A1"}]}\n```',
      "a"
    );
    const b = seedWorklistFromPlan(
      dir,
      '```json\n{"goal":"b","items":[{"title":"B1"}]}\n```',
      "b"
    );

    expect(a.ok && b.ok).toBe(true);

    if (!a.ok || !b.ok) {
      return;
    }

    expect(a.plan.id).not.toBe(b.plan.id);
    expect(loadPlan(dir, a.plan.id)?.goal).toBe("a");
    expect(loadPlan(dir, b.plan.id)?.goal).toBe("b");
    expect(loadPlanIndex(dir).plans).toHaveLength(2);
  });

  test("refuses when JSON missing", () => {
    const result = seedWorklistFromPlan(
      dir,
      "## Plan\n\nWe should refactor auth somehow.\n",
      "vague"
    );

    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.error).toMatch(/fenced JSON/i);
  });

  test("refuses empty items", () => {
    const result = seedWorklistFromPlan(
      dir,
      '```json\n{"goal":"x","items":[]}\n```',
      "x"
    );

    expect(result.ok).toBe(false);
  });
});

describe("goalFromMessages", () => {
  test("uses the first user ask, stripping PLAN_MODE_NOTE", () => {
    expect(
      goalFromMessages([
        {
          role: "user",
          content: "fix the Tasks rail\n\n[PLAN MODE — read-only. …]",
        },
        { role: "assistant", content: "```json\n{\"items\":[{\"title\":\"a\"}]}\n```" },
      ])
    ).toBe("fix the Tasks rail");
  });
});
