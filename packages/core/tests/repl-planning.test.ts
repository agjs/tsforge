import { test, expect } from "bun:test";
import { parseReviewResponse } from "../src/cli/repl";

test("parseReviewResponse: approve words → approve", () => {
  for (const s of ["approve", "a", "y", " APPROVE ", "Approve"]) {
    expect(parseReviewResponse(s)).toEqual({ action: "approve" });
  }
});

test("parseReviewResponse: cancel words → cancel", () => {
  for (const s of ["cancel", "c", "n", " Cancel "]) {
    expect(parseReviewResponse(s)).toEqual({ action: "cancel" });
  }
});

test("parseReviewResponse: anything else → revise, preserving the raw note", () => {
  const note = "make the note field required";

  expect(parseReviewResponse(note)).toEqual({ action: "revise", note });
});
