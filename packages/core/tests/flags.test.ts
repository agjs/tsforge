import { test, expect, afterEach } from "bun:test";
import { flags } from "../src/config";

// WS-B: the near-green checkpoint is DEFAULT ON (it fixes the near-green oscillation that
// thrashes real builds — users shouldn't need to know a flag exists). A kill-switch
// TSFORGE_NO_NEAR_GREEN_CHECKPOINT=1 disables it. Read LIVE so a run/test can toggle it.

afterEach(() => {
  delete process.env.TSFORGE_NO_NEAR_GREEN_CHECKPOINT;
});

test("nearGreenCheckpoint is ON by default; the kill-switch disables it", () => {
  delete process.env.TSFORGE_NO_NEAR_GREEN_CHECKPOINT;
  expect(flags.nearGreenCheckpoint()).toBe(true);

  process.env.TSFORGE_NO_NEAR_GREEN_CHECKPOINT = "1";
  expect(flags.nearGreenCheckpoint()).toBe(false);

  // Any non-"1" value leaves it ON (the FLAG_ON contract).
  process.env.TSFORGE_NO_NEAR_GREEN_CHECKPOINT = "0";
  expect(flags.nearGreenCheckpoint()).toBe(true);
});
