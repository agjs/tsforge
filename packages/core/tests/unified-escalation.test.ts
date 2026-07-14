import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/loop/run";
import { composeGate, type IStage } from "../src/gate/gate-runner";
import { RUN_STATUS, STUCK_REASON } from "../src/loop";
import type { IProvider } from "../src/inference";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-escalation-"));
}

test("a persistently-red judge gate escalates through the ladder and hands off", async () => {
  const dir = await tmp();

  try {
    // A gate that ALWAYS rejects on the same judge error — the live failure class
    // that ground with zero escalations because the gate ran outside the loop.
    const alwaysRed: IStage = {
      run: async () => ({
        passed: false,
        errors: [
          {
            key: "judge:note",
            rule: "judge",
            file: "note.ts",
            message: "still a stub",
          },
        ],
        output: "still a stub",
      }),
    };

    // A model that emits an edit each turn (so turns count as working turns and
    // the loop re-runs the gate), but the edit doesn't satisfy the judge.
    let turnCount = 0;

    const model: IProvider = {
      async complete() {
        turnCount += 1;

        // Each turn, edit a real file in the task scope
        // (so the loop sees working turns and re-runs the gate).
        return {
          content: `turn ${turnCount}`,
          toolCalls: [
            {
              name: "edit",
              arguments: {
                file: "note.ts",
                oldString: `export const note = "${turnCount - 1}";`,
                newString: `export const note = "${turnCount}";`,
              },
            },
          ],
        };
      },
    };

    // Set up the initial file for editing
    await writeFile(join(dir, "note.ts"), 'export const note = "0";');

    const result = await runTask(
      {
        id: "note",
        intent: "build note",
        accept: "test -f never.txt",
        files: ["**/*"],
        context: [],
      },
      dir,
      model,
      { gate: composeGate([alwaysRed]), maxTurns: 60 }
    );

    // The primary terminal is ladder-exhaustion (R5 handoff), NOT the turn cap.
    expect(result.status).toBe(RUN_STATUS.stuck);
    expect(result.reason).toBe(STUCK_REASON.handoff);
    expect(result.handoff).toBeDefined();

    // The block was tracked and levers were tried (escalation actually fired).
    const rungCount = result.handoff?.rungHistory.length ?? 0;

    expect(rungCount).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
