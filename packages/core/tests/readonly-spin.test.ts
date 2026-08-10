import { test, expect, describe } from "bun:test";
import {
  filterWriteForceTools,
  nextReadonlyStreak,
  streakAfterReadonlyResteer,
  toolCallsAttemptWrite,
} from "../src/loop/readonly-spin";
import { READONLY_STREAK_LIMIT } from "../src/loop/loop.constants";

describe("nextReadonlyStreak", () => {
  test("successful write resets streak", () => {
    expect(
      nextReadonlyStreak({
        previous: 5,
        progressed: true,
        attemptedWrite: false,
      })
    ).toBe(0);
  });

  test("attempted create/edit resets streak even when args rejected", () => {
    // Shiphold: tool_input_rejected:create was counted as "only reading".
    expect(
      nextReadonlyStreak({
        previous: 4,
        progressed: false,
        attemptedWrite: true,
      })
    ).toBe(0);
    expect(toolCallsAttemptWrite([{ name: "create" }])).toBe(true);
    expect(toolCallsAttemptWrite([{ name: "read" }])).toBe(false);
    expect(toolCallsAttemptWrite([{ name: "check" }])).toBe(true);
    expect(toolCallsAttemptWrite([{ name: "task_complete" }])).toBe(true);
  });

  test("pure reads increment (no survey grace)", () => {
    expect(
      nextReadonlyStreak({
        previous: 5,
        progressed: false,
        attemptedWrite: false,
      })
    ).toBe(6);
  });
});

describe("readonly re-steer helpers", () => {
  test("streakAfterReadonlyResteer stays hot near the limit", () => {
    expect(streakAfterReadonlyResteer(READONLY_STREAK_LIMIT)).toBe(
      READONLY_STREAK_LIMIT - 1
    );
    expect(streakAfterReadonlyResteer(1)).toBe(1);
  });

  test("filterWriteForceTools drops read/search/run", () => {
    const tools = [
      { function: { name: "read" } },
      { function: { name: "create" } },
      { function: { name: "edit" } },
      { function: { name: "run" } },
      { function: { name: "edit_lines" } },
    ];
    const forced = filterWriteForceTools(tools).map((t) => t.function.name);

    expect(forced).toEqual(["create", "edit", "edit_lines"]);
  });
});
