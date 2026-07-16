import { test, expect, describe } from "bun:test";
import {
  parseDiagnosis,
  renderDiagnosePrompt,
  DIAGNOSE_SYSTEM_PROMPT,
  FAILURE_CATEGORIES,
} from "../src/reviewers/diagnose-schema";

describe("parseDiagnosis", () => {
  const valid = {
    category: "gate-parity",
    confidence: "high",
    rootCause: "fast gate != acceptance",
    suggestedFix: "make them identical",
  };

  test("accepts a well-formed diagnosis", () => {
    const d = parseDiagnosis("r1", valid);

    expect(d).not.toBeNull();
    expect(d?.category).toBe("gate-parity");
    expect(d?.reviewerId).toBe("r1");
  });

  test("rejects an unknown category", () => {
    expect(parseDiagnosis("r1", { ...valid, category: "made-up" })).toBeNull();
  });

  test("rejects a bad confidence", () => {
    expect(
      parseDiagnosis("r1", { ...valid, confidence: "certain" })
    ).toBeNull();
  });

  test("rejects missing rootCause / suggestedFix", () => {
    expect(parseDiagnosis("r1", { ...valid, rootCause: undefined })).toBeNull();
    expect(parseDiagnosis("r1", { ...valid, suggestedFix: 5 })).toBeNull();
  });

  test("rejects a non-object", () => {
    expect(parseDiagnosis("r1", "nope")).toBeNull();
    expect(parseDiagnosis("r1", null)).toBeNull();
  });
});

describe("renderDiagnosePrompt", () => {
  test("includes the domain, park reason, note, and slice", () => {
    const p = renderDiagnosePrompt({
      domain: "expense",
      parkReason: "ladder exhausted",
      turnsSummary: "141 turns",
      logSlice: "[fix] parked",
      sliceNote: "kept 30 of 900",
    });

    expect(p).toContain("expense");
    expect(p).toContain("ladder exhausted");
    expect(p).toContain("kept 30 of 900");
    expect(p).toContain("[fix] parked");
  });
});

describe("DIAGNOSE_SYSTEM_PROMPT", () => {
  test("names every category so reviewers map to the enum", () => {
    for (const c of FAILURE_CATEGORIES) {
      expect(DIAGNOSE_SYSTEM_PROMPT).toContain(c);
    }
  });

  test("demands a single JSON object", () => {
    expect(DIAGNOSE_SYSTEM_PROMPT).toContain("ONE JSON object");
  });
});
