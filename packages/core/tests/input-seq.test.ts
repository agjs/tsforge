import { test, expect } from "bun:test";
import {
  takeOneInputSequence,
  normalizePaneControlSeq,
} from "../src/render/frame/input-seq";

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

test("takeOneInputSequence: peels emoji as one grapheme", () => {
  const wave = takeOneInputSequence("👋x");

  expect(wave.seq).toBe("👋");
  expect(wave.rest).toBe("x");
});

test("takeOneInputSequence: peels combining accent as one grapheme", () => {
  // e + combining acute
  const accented = takeOneInputSequence("e\u0301x");

  expect(accented.seq).toBe("e\u0301");
  expect(accented.rest).toBe("x");
});

test("normalizePaneControlSeq: Kitty CSI-u Ctrl+G / Ctrl+O", () => {
  expect(normalizePaneControlSeq("\x1b[103;5u")).toBe("\x07");
  expect(normalizePaneControlSeq("\x1b[111;5u")).toBe("\x0f");
  expect(normalizePaneControlSeq("\x07")).toBe("\x07");
});
