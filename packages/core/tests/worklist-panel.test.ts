import { test, expect, describe } from "bun:test";
import { formatWorklistLines, worklistBadge } from "../src/loop/worklist/panel";
import type { IGreenfieldState } from "../src/loop/greenfield";
import { stripSgr } from "../src/render/frame";
import { CONSOLE } from "../src/render/frame/chrome";

function state(
  features: IGreenfieldState["features"],
  goal = "g"
): IGreenfieldState {
  return { goal, features };
}

function plain(lines: readonly string[]): string[] {
  return lines.map(stripSgr);
}

describe("formatWorklistLines", () => {
  test("shows goal cue, current ▸, pending ○ — no worklist N/M header", () => {
    const lines = formatWorklistLines(
      state(
        [
          { id: "a", desc: "First", passes: true, attempts: 1 },
          { id: "b", desc: "Second", passes: false, attempts: 0 },
          { id: "c", desc: "Third", passes: false, attempts: 0 },
          { id: "d", desc: "Fourth", passes: false, attempts: 0 },
        ],
        "PLAN.md"
      ),
      { maxPending: 2, columns: 36, color: false }
    );
    const text = plain(lines);

    expect(text[0]).toBe("PLAN.md");
    expect(text.some((l) => l.startsWith("worklist"))).toBe(false);
    expect(text).toContain("✓ First");
    expect(text).toContain("▸ Second");
    expect(text).toContain("○ Third");
    expect(text).toContain("○ Fourth");
  });

  test("wraps long descriptions to columns", () => {
    const columns = 20;
    const lines = formatWorklistLines(
      state(
        [
          {
            id: "a",
            desc: "Accept a one-line goal and produce a sprint checklist",
            passes: false,
            attempts: 0,
          },
        ],
        "worklist"
      ),
      { columns, color: false }
    );
    const text = plain(lines);
    const current = text.find((l) => l.startsWith("▸ "));

    expect(current).toBeDefined();
    expect(text.length).toBeGreaterThan(1);
    expect(text.some((l) => l.startsWith("  "))).toBe(true);

    for (const line of text) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }

    expect(text.join(" ")).toContain("checklist");
    expect(text.join("\n")).not.toMatch(/checklis\n/u);
  });

  test("empty state points at /work PLAN.md", () => {
    expect(
      plain(formatWorklistLines(state([], "worklist"), { color: false }))
    ).toEqual(["/work PLAN.md", "or /work <goal>"]);
  });

  test("all done and parked-only copy", () => {
    expect(
      plain(
        formatWorklistLines(
          state([{ id: "a", desc: "A", passes: true, attempts: 1 }]),
          { color: false }
        )
      )
    ).toContain("All done.");

    const parked = plain(
      formatWorklistLines(
        state([
          { id: "a", desc: "A", passes: true, attempts: 1 },
          { id: "b", desc: "B", passes: false, attempts: 2, parked: true },
        ]),
        { color: false }
      )
    );

    expect(parked.some((l) => l.includes("Parked 1"))).toBe(true);
    expect(parked.some((l) => l.startsWith("~ "))).toBe(true);
  });

  test("selection prefix when focused skips double ▸ on current", () => {
    const lines = formatWorklistLines(
      state([{ id: "a", desc: "A", passes: false, attempts: 0 }], "worklist"),
      { showSelection: true, selectedIndex: 0, color: false }
    );

    expect(plain(lines)[0]?.startsWith("▸ ")).toBe(true);
    expect(plain(lines)[0]?.startsWith("▸ ▸")).toBe(false);
  });

  test("color mode paints current with CONSOLE.bright", () => {
    const lines = formatWorklistLines(
      state([{ id: "a", desc: "Now", passes: false, attempts: 0 }], "worklist"),
      { columns: 36, color: true }
    );

    expect(lines.some((l) => l.includes(CONSOLE.bright))).toBe(true);
  });

  test("worklistBadge is done/total", () => {
    expect(
      worklistBadge(
        state([
          { id: "a", desc: "A", passes: true, attempts: 1 },
          { id: "b", desc: "B", passes: false, attempts: 0 },
        ])
      )
    ).toBe("1/2");
    expect(worklistBadge(state([]))).toBe("");
  });
});
