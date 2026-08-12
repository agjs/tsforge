import { test, expect } from "bun:test";
import { takeOneInputSequence } from "../src/render/frame/input-seq";

test("takeOneInputSequence: peels Ctrl+G before a following character", () => {
  const first = takeOneInputSequence("\x07x");

  expect(first.seq).toBe("\x07");
  expect(first.rest).toBe("x");

  const second = takeOneInputSequence(first.rest);

  expect(second.seq).toBe("x");
  expect(second.rest).toBe("");
});

test("takeOneInputSequence: peels CSI arrow sequences", () => {
  const up = takeOneInputSequence("\x1b[Arest");

  expect(up.seq).toBe("\x1b[A");
  expect(up.rest).toBe("rest");
});
