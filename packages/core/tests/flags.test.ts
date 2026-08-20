import { test, expect, afterEach } from "bun:test";
import { flags } from "../src/config";

// WS-B: the near-green checkpoint is DEFAULT ON (it fixes the near-green oscillation that
// thrashes real builds — users shouldn't need to know a flag exists). A kill-switch
// TSFORGE_NO_NEAR_GREEN_CHECKPOINT=1 disables it. Read LIVE so a run/test can toggle it.

afterEach(() => {
  delete process.env.TSFORGE_NO_NEAR_GREEN_CHECKPOINT;
  delete process.env.TSFORGE_NO_NEAR_GREEN_ROTATION;
  delete process.env.TSFORGE_NO_REVIEW;
});

// The post-work agent review is DEFAULT ON (first-class after-green phase); the
// TSFORGE_NO_REVIEW kill-switch disables it (eval sweeps / cost-sensitive runs).
test("noReview is OFF by default (review on); the kill-switch turns review off", () => {
  delete process.env.TSFORGE_NO_REVIEW;
  expect(flags.noReview()).toBe(false);

  process.env.TSFORGE_NO_REVIEW = "1";
  expect(flags.noReview()).toBe(true);

  // Any non-"1" value leaves review ON (the FLAG_ON contract).
  process.env.TSFORGE_NO_REVIEW = "0";
  expect(flags.noReview()).toBe(false);
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

// #77: the near-green ROTATION steer is DEFAULT ON (the last-mile fix for the rotating-error
// oscillation that parked build17) with the same TSFORGE_NO_* kill-switch convention.
test("nearGreenRotation is ON by default; the kill-switch disables it", () => {
  delete process.env.TSFORGE_NO_NEAR_GREEN_ROTATION;
  expect(flags.nearGreenRotation()).toBe(true);

  process.env.TSFORGE_NO_NEAR_GREEN_ROTATION = "1";
  expect(flags.nearGreenRotation()).toBe(false);

  // Any non-"1" value leaves it ON (the FLAG_ON contract).
  process.env.TSFORGE_NO_NEAR_GREEN_ROTATION = "0";
  expect(flags.nearGreenRotation()).toBe(true);
});
