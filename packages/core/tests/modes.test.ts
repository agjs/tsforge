import { test, expect } from "bun:test";
import {
  SESSION_MODES,
  modeById,
  nextMode,
  type IModeTarget,
} from "../src/cli/modes";

function recorder(): { target: IModeTarget; calls: boolean[] } {
  const calls: boolean[] = [];

  return { target: { setPlanMode: (on) => calls.push(on) }, calls };
}

test("Shift+Tab cycles normal -> plan -> normal (wraps)", () => {
  expect(nextMode("normal").id).toBe("plan");
  expect(nextMode("plan").id).toBe("normal");
});

test("an unknown current id cycles to the first mode", () => {
  expect(nextMode("bogus").id).toBe("normal");
  expect(SESSION_MODES[0]?.id).toBe("normal");
});

test("modeById returns the mode, and falls back to normal for unknown ids", () => {
  expect(modeById("plan").id).toBe("plan");
  expect(modeById("normal").id).toBe("normal");
  expect(modeById("nope").id).toBe("normal");
});

test("plan mode realizes as setPlanMode(true); normal as setPlanMode(false)", () => {
  const a = recorder();

  modeById("plan").apply(a.target);
  expect(a.calls).toEqual([true]);

  const b = recorder();

  modeById("normal").apply(b.target);
  expect(b.calls).toEqual([false]);
});

test("every registered mode has a non-empty id and label (extensibility guard)", () => {
  expect(SESSION_MODES.length).toBeGreaterThanOrEqual(2);

  for (const mode of SESSION_MODES) {
    expect(mode.id.length).toBeGreaterThan(0);
    expect(mode.label.length).toBeGreaterThan(0);
  }
});
