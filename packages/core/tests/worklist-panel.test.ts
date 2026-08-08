import { test, expect, describe } from "bun:test";
import { formatWorklistLines, worklistBadge } from "../src/loop/worklist/panel";
import type { IGreenfieldState } from "../src/loop/greenfield";

function state(features: IGreenfieldState["features"]): IGreenfieldState {
  return { goal: "g", features };
}

describe("formatWorklistLines", () => {
  test("shows count, current item with [>], and pending", () => {
    const lines = formatWorklistLines(
      state([
        { id: "a", desc: "First", passes: true, attempts: 1 },
        { id: "b", desc: "Second", passes: false, attempts: 0 },
        { id: "c", desc: "Third", passes: false, attempts: 0 },
        { id: "d", desc: "Fourth", passes: false, attempts: 0 },
      ]),
      { maxPending: 2 }
    );

    expect(lines[0]).toBe("worklist  1/4");
    expect(lines[1]).toBe("[>] Second");
    expect(lines[2]).toBe("[ ] Third");
    expect(lines[3]).toBe("[ ] Fourth");
  });

  test("empty state points at /work", () => {
    expect(formatWorklistLines(state([]))).toEqual([
      "worklist",
      "/work to start",
    ]);
  });

  test("all done and parked-only copy", () => {
    expect(
      formatWorklistLines(
        state([{ id: "a", desc: "A", passes: true, attempts: 1 }])
      )[1]
    ).toBe("All done.");

    const parked = formatWorklistLines(
      state([
        { id: "a", desc: "A", passes: true, attempts: 1 },
        { id: "b", desc: "B", passes: false, attempts: 2, parked: true },
      ])
    );

    expect(parked[1]).toBe("Parked 1 — revisit");
  });

  test("selection prefix when focused", () => {
    const lines = formatWorklistLines(
      state([{ id: "a", desc: "A", passes: false, attempts: 0 }]),
      { showSelection: true, selectedIndex: 1 }
    );

    expect(lines[1]?.startsWith("▸ ")).toBe(true);
    expect(lines[0]?.startsWith("  ")).toBe(true);
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
