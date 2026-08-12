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

test("takeOneInputSequence: keeps Alt+Enter as one sequence", () => {
  const altEnter = takeOneInputSequence("\x1b\rsecond");

  expect(altEnter.seq).toBe("\x1b\r");
  expect(altEnter.rest).toBe("second");
});

test("takeOneInputSequence: bare Esc stays alone", () => {
  const bare = takeOneInputSequence("\x1b");

  expect(bare.seq).toBe("\x1b");
  expect(bare.rest).toBe("");
});
