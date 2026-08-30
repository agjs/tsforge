import { expect, test } from "bun:test";
import { createRateLimiter } from "./rate-limit";

test("allows up to the limit per window, then blocks", () => {
  let t = 0;
  const rl = createRateLimiter(2, 1000, () => t);

  expect(rl.allow("a")).toBe(true);
  expect(rl.allow("a")).toBe(true);
  expect(rl.allow("a")).toBe(false);
});

test("frees capacity as hits leave the sliding window", () => {
  let t = 0;
  const rl = createRateLimiter(1, 1000, () => t);

  expect(rl.allow("a")).toBe(true);
  expect(rl.allow("a")).toBe(false);

  t = 1001;
  expect(rl.allow("a")).toBe(true);
});

test("tracks keys independently", () => {
  let t = 0;
  const rl = createRateLimiter(1, 1000, () => t);

  expect(rl.allow("a")).toBe(true);
  expect(rl.allow("b")).toBe(true);
});
