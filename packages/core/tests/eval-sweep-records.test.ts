import { test, expect } from "bun:test";
import { parseSweepRecords } from "../src/eval";

// A metric that survives the run but not the reload is not measured. This read back
// only label/passed/cycles/ms/quality, so a re-rendered report showed empty cost
// columns — and had already been losing loc and failureClass — for data sitting in
// the JSON on disk.
test("rehydrates every metric a saved record carries", () => {
  const records = parseSweepRecords({
    records: [
      {
        label: "baseline temp=0",
        passed: true,
        cycles: 3,
        ms: 4321,
        quality: 4,
        loc: 22,
        tokensOut: 8000,
        tokensIn: 3000,
        costPerAcceptedChange: 2000,
      },
    ],
  });

  expect(records).toEqual([
    {
      label: "baseline temp=0",
      passed: true,
      cycles: 3,
      ms: 4321,
      quality: 4,
      loc: 22,
      tokensOut: 8000,
      tokensIn: 3000,
      costPerAcceptedChange: 2000,
    },
  ]);
});

test("keeps a known failure class and drops an unrecognised one", () => {
  const [good] = parseSweepRecords({
    records: [
      {
        label: "a",
        passed: false,
        cycles: 1,
        ms: 1,
        failureClass: "type-error",
      },
    ],
  });

  expect(good?.failureClass).toBe("type-error");

  // An older or hand-edited file must not smuggle an arbitrary string into a typed
  // field.
  const [bogus] = parseSweepRecords({
    records: [
      {
        label: "a",
        passed: false,
        cycles: 1,
        ms: 1,
        failureClass: "not-a-class",
      },
    ],
  });

  expect(bogus?.failureClass).toBeUndefined();
});

test("omits absent optional metrics rather than inventing zeros", () => {
  const [record] = parseSweepRecords({
    records: [{ label: "a", passed: true, cycles: 1, ms: 5 }],
  });

  expect(record).toEqual({ label: "a", passed: true, cycles: 1, ms: 5 });
});

// buildRunRecord omits a non-positive cost so it is treated as ABSENT and skipped by
// the averages. Reading a saved 0 back as a real figure would put it in the
// denominator and drag the reported cost down — cheaper the more runs spent nothing.
test("treats a saved zero or non-finite cost as absent", () => {
  const [zeroed] = parseSweepRecords({
    records: [
      {
        label: "a",
        passed: false,
        cycles: 4,
        ms: 10,
        tokensOut: 0,
        tokensIn: 0,
        costPerAcceptedChange: 0,
      },
    ],
  });

  expect(zeroed?.tokensOut).toBeUndefined();
  expect(zeroed?.tokensIn).toBeUndefined();
  expect(zeroed?.costPerAcceptedChange).toBeUndefined();

  // A hand-edited or corrupted file must not inject NaN into an average either.
  const [nan] = parseSweepRecords({
    records: [
      {
        label: "a",
        passed: true,
        cycles: 1,
        ms: 10,
        tokensOut: Number.NaN,
        costPerAcceptedChange: -5,
      },
    ],
  });

  expect(nan?.tokensOut).toBeUndefined();
  expect(nan?.costPerAcceptedChange).toBeUndefined();
});

test("ignores malformed rows and non-sweep input", () => {
  expect(parseSweepRecords({ records: [{ label: "a" }] })).toEqual([]);
  expect(parseSweepRecords({})).toEqual([]);
  expect(parseSweepRecords(null)).toEqual([]);
});
