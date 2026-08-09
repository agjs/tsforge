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
  test("labels PLAN/TASKS and draws parent→child tree with status marks", () => {
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

    expect(text[0]).toBe("PLAN");
    expect(text[1]).toBe("");
    expect(text).toContain("PLAN.md");
    expect(text).toContain("TASKS");
    expect(text).not.toContain("TASKS  1/4");
    expect(text[text.indexOf("TASKS") - 1]).toBe("");
    expect(text[text.indexOf("TASKS") + 1]).toBe("");
    expect(text).toContain("├─ [✓] First");
    expect(text).toContain("├─ [>] Second");
    expect(text).toContain("│  └─ [ ] Child");
    expect(text).toContain("└─ [ ] Third");
  });

  test("soft-wraps long goal — no mid-word clip", () => {
    const goal =
      "Harden and extend the tiny notes CLI with delete, atomic saves, and corrupt JSON handling";
    const lines = formatWorklistLines(
      plan(
        [{ id: "a", title: "Make saveNotes atomic", status: "pending" }],
        goal
      ),
      { columns: 28, color: false }
    );
    const text = plain(lines).join("\n");

    expect(text).toContain("Harden");
    expect(text).toContain("handling");
    expect(text).not.toMatch(/tiny not$/mu);
    expect(plain(lines).length).toBeGreaterThan(2);
  });

  test("color mode paints done glyphs green", () => {
    const lines = formatWorklistLines(
      plan([{ id: "a", title: "Done item", status: "done" }]),
      { columns: 36, color: true }
    );

    expect(
      lines.some((l) => l.includes(CONSOLE.green) && l.includes("[✓]"))
    ).toBe(true);
  });

  test("shows verify under focused row, tree-indented", () => {
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

  test("completed plan: blanks around sections, count only in sticky header", () => {
    const text = plain(
      formatWorklistLines(plan([{ id: "a", title: "A", status: "done" }]), {
        color: false,
      })
    );
    const tasksIdx = text.indexOf("TASKS");

    expect(text[0]).toBe("PLAN");
    expect(text[1]).toBe("");
    expect(tasksIdx).toBeGreaterThan(0);
    expect(text[tasksIdx - 1]).toBe("");
    expect(text[tasksIdx + 1]).toBe("");
    expect(text.some((l) => l.includes("[✓] A"))).toBe(true);
    expect(text).not.toContain("All done.");
    expect(text.every((l) => !/\d+\/\d+/u.test(l))).toBe(true);
  });

  test("color mode paints current mark bright and body fg (not cyan)", () => {
    const lines = formatWorklistLines(
      plan([{ id: "a", title: "Now", status: "active" }], "g", "a"),
      { columns: 36, color: true }
    );

    expect(
      lines.some((l) => l.includes(CONSOLE.bright) && l.includes("[>]"))
    ).toBe(true);
    expect(lines.some((l) => l.includes(CONSOLE.fg) && l.includes("Now"))).toBe(
      true
    );
    expect(lines.every((l) => !l.includes("38;2;125;211;252"))).toBe(true);
    expect(lines.every((l) => !l.includes("38;2;34;211;238"))).toBe(true);
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

  test("formatPlanProposal is a PLAN card with tree items, not raw JSON", () => {
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
    expect(card).toContain("└─ [ ] Wire present_plan");
    expect(card).toContain("└─ [ ] Nested");
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
