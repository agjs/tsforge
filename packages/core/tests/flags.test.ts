import { test, expect, afterEach } from "bun:test";
import { flags } from "../src/config";

// WS-B: the nearGreenCheckpoint flag gates the whole feature. It must be OFF by default
// (so no path changes until a builder opts in) and read LIVE from the env (so a run/test
// can toggle it). Locks the accessor directly, not just via the loop integration tests.

afterEach(() => {
  delete process.env.TSFORGE_NEAR_GREEN_CHECKPOINT;
});

test("nearGreenCheckpoint is OFF by default and reads TSFORGE_NEAR_GREEN_CHECKPOINT live", () => {
  delete process.env.TSFORGE_NEAR_GREEN_CHECKPOINT;
  expect(flags.nearGreenCheckpoint()).toBe(false);

  process.env.TSFORGE_NEAR_GREEN_CHECKPOINT = "1";
  expect(flags.nearGreenCheckpoint()).toBe(true);

  // Any non-"1" value is off (the FLAG_ON contract).
  process.env.TSFORGE_NEAR_GREEN_CHECKPOINT = "0";
  expect(flags.nearGreenCheckpoint()).toBe(false);
});
