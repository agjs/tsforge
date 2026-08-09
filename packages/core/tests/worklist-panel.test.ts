import { test, expect, describe } from "bun:test";
import {
  formatWorklistLines,
  formatPlanProposal,
  worklistBadge,
  pendingPlanBadge,
} from "../src/loop/worklist/panel";
import type { IPlanDocument } from "../src/loop/worklist/checklist.types";
import { stripSgr } from "../src/render/frame";
import { CONSOLE } from "../src/render/frame/chrome";

function plan(
  items: IPlanDocument["items"],
  goal = "g",
  activeItemId: string | null = null
): IPlanDocument {
  return {
    schemaVersion: 2,
    id: "plan-1",
    goal,
    activeItemId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    items,
  };
}

function plain(lines: readonly string[]): string[] {
  return lines.map(stripSgr);
}

describe("formatWorklistLines", () => {
  test("shows goal cue, nested tree, active ▸", () => {
    const lines = formatWorklistLines(
      plan(
        [
          { id: "a", title: "First", status: "done" },
          {
            id: "b",
            title: "Second",
            status: "active",
            children: [{ id: "b1", title: "Child", status: "pending" }],
          },
          { id: "c", title: "Third", status: "pending" },
        ],
        "PLAN.md",
        "b"
      ),
      { maxPending: 4, columns: 36, color: false }
    );
    const text = plain(lines);

    expect(text[0]).toBe("PLAN.md");
    expect(text).toContain("✓ First");
    expect(text).toContain("▸ Second");
    expect(text.some((l) => l.includes("Child"))).toBe(true);
    expect(text).toContain("○ Third");
  });

  test("shows verify on focused row", () => {
    const lines = formatWorklistLines(
      plan(
        [
          {
            id: "a",
            title: "Wire rail",
            status: "active",
            verify: "bun test panel",
          },
        ],
        "goal",
        "a"
      ),
      { columns: 40, color: false }
    );
    const text = plain(lines);

    expect(text.some((l) => l.includes("verify: bun test panel"))).toBe(true);
  });

  test("empty state points at plan approve", () => {
    expect(plain(formatWorklistLines(null, { color: false }))).toEqual([
      "approve a plan",
      "to fill this list",
    ]);
  });

  test("all done copy", () => {
    expect(
      plain(
        formatWorklistLines(plan([{ id: "a", title: "A", status: "done" }]), {
          color: false,
        })
      )
    ).toContain("All done.");
  });

  test("color mode paints current with CONSOLE.bright", () => {
    const lines = formatWorklistLines(
      plan([{ id: "a", title: "Now", status: "active" }], "g", "a"),
      { columns: 36, color: true }
    );

    expect(lines.some((l) => l.includes(CONSOLE.bright))).toBe(true);
  });

  test("worklistBadge is done/total", () => {
    expect(
      worklistBadge(
        plan([
          { id: "a", title: "A", status: "done" },
          { id: "b", title: "B", status: "pending" },
        ])
      )
    ).toBe("1/2");
    expect(worklistBadge(null)).toBe("");
  });

  test("formatPlanProposal is a PLAN card with items, not raw JSON", () => {
    const card = formatPlanProposal(
      plan(
        [
          {
            id: "a",
            title: "Wire present_plan",
            status: "pending",
            children: [{ id: "a1", title: "Nested", status: "pending" }],
          },
        ],
        "Ship plan UI"
      ),
      60,
      false
    );

    expect(card).toContain("PLAN");
    expect(card).toContain("Ship plan UI");
    expect(card).toContain("Wire present_plan");
    expect(card).toContain("Nested");
    expect(card).toContain("approve");
    expect(card).not.toContain('"items"');
  });

  test("formatPlanProposal soft-wraps long detail — no mid-word clip", () => {
    const detail =
      "Bun CLI with subcommands: add <text>, list, search <query>. Persists notes to .notes.json (id, text, createdAt ISO). Search matches case-insensitive.";
    const card = formatPlanProposal(
      plan(
        [
          {
            id: "a",
            title: "Create src/notes.ts CLI",
            status: "pending",
            detail,
          },
        ],
        "Build a tiny static notes CLI"
      ),
      48,
      false
    );
    const plain = stripSgr(card);

    expect(plain).toContain("Search");
    expect(plain).not.toMatch(/Searc[^h]/u);
    expect(plain.split("\n").length).toBeGreaterThan(6);
  });

  test("pendingPlanBadge marks open count", () => {
    expect(
      pendingPlanBadge(plan([{ id: "a", title: "A", status: "pending" }]))
    ).toBe("·1");
  });
});
