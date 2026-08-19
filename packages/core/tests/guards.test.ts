import { test, expect, describe } from "bun:test";
import { isRecord, isArray } from "../src/lib/guards";

describe("isRecord", () => {
  test("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  test("REJECTS arrays (typeof [] === 'object' — the S1 hole)", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
  });

  test("rejects null, primitives, and functions", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(() => undefined)).toBe(false);
  });

  test("a nested array in untrusted JSON no longer narrows to a record", () => {
    // The plan.ts shape: steps: [[1,2],[3,4]] — each nested array must NOT
    // pass as an IStep-like record.
    const parsed: unknown = JSON.parse('{"steps":[[1,2],[3,4]]}');
    const steps = isRecord(parsed) && isArray(parsed.steps) ? parsed.steps : [];

    expect(steps.filter((s) => isRecord(s))).toEqual([]);
  });
});

describe("isArray", () => {
  test("accepts arrays only", () => {
    expect(isArray([])).toBe(true);
    expect(isArray([1])).toBe(true);
    expect(isArray({})).toBe(false);
    expect(isArray(null)).toBe(false);
    expect(isArray("x")).toBe(false);
  });
});
