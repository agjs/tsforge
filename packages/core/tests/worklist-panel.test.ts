import { test, expect, describe } from "bun:test";
import {
  formatWorklistLines,
  formatPlanProposal,
  worklistBadge,
  pendingPlanBadge,
  parseWorklistBadge,
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
  test("soft goal + hairline + tree — no body PLAN/TASKS labels", () => {
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
    expect(text[1]).toMatch(/^─+$/);
    expect(text[2]).toBe("");
    expect(text.every((l) => l !== "PLAN" && l !== "TASKS")).toBe(true);
    expect(text).toContain("├─ [✓] First");
    expect(text).toContain("├─ [∙] Second");
    expect(text).toContain("│  └─ [ ] Child");
    expect(text).toContain("└─ [ ] Third");
    expect(text).not.toContain("complete");
  });

  test("current mark spins when currentFrame is set", () => {
    const p = plan(
      [{ id: "a", title: "Add clear command", status: "active" }],
      "g",
      "a"
    );
    const idle = plain(
      formatWorklistLines(p, { columns: 36, color: false })
    ).join("\n");
    const spin = plain(
      formatWorklistLines(p, { columns: 36, color: false, currentFrame: 0 })
    ).join("\n");

    expect(idle).toContain("[∙] Add clear command");
    expect(spin).toContain("[⠋] Add clear command");
    expect(spin).not.toContain("[∙]");
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
    expect(text).not.toMatch(/tiny not$/mu);
    expect(plain(lines).length).toBeGreaterThan(2);
  });

  test("clamps a novel-length goal to 3 lines with ellipsis", () => {
    const goal = Array.from({ length: 40 }, (_, i) => `word${String(i)}`).join(
      " "
    );
    const lines = formatWorklistLines(
      plan([{ id: "a", title: "Item", status: "pending" }], goal),
      { columns: 24, color: false }
    );
    const beforeRule = [];

    for (const line of plain(lines)) {
      if (/^─+$/u.test(line)) {
        break;
      }

      beforeRule.push(line);
    }

    expect(beforeRule.length).toBe(3);
    expect(beforeRule[2]?.endsWith("…")).toBe(true);
    expect(plain(lines).join("\n")).toContain("Item");
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

  test("all done: no complete/All done footer — sticky 4/4 is enough", () => {
    const text = plain(
      formatWorklistLines(plan([{ id: "a", title: "A", status: "done" }]), {
        color: false,
      })
    );

    expect(text[0]).toBe("g");
    expect(text[1]).toMatch(/^─+$/);
    expect(text.some((l) => l.includes("[✓] A"))).toBe(true);
    expect(text).not.toContain("complete");
    expect(text).not.toContain("All done.");
    expect(text.every((l) => l !== "PLAN" && l !== "TASKS")).toBe(true);
    expect(text.every((l) => !/\d+\/\d+/u.test(l))).toBe(true);
  });

  test("color mode paints current bright (not cyan)", () => {
    const lines = formatWorklistLines(
      plan([{ id: "a", title: "Now", status: "active" }], "g", "a"),
      { columns: 36, color: true }
    );

    expect(
      lines.some((l) => l.includes(CONSOLE.bright) && l.includes("[∙]"))
    ).toBe(true);
    expect(
      lines.some((l) => l.includes(CONSOLE.bright) && l.includes("Now"))
    ).toBe(true);
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

  test("parseWorklistBadge maps pending ·N to 0/N (not blank 0/0)", () => {
    expect(parseWorklistBadge("·13")).toEqual({ done: 0, total: 13 });
    expect(parseWorklistBadge("3/7")).toEqual({ done: 3, total: 7 });
    expect(parseWorklistBadge("")).toEqual({ done: 0, total: 0 });
  });
});
