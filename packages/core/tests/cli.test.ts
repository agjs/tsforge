import { test, expect } from "bun:test";
import { parseArgs, isOneShot } from "../src/cli";

test("parses task + files + accept + dir", () => {
  const a = parseArgs([
    "add",
    "a",
    "clear",
    "button",
    "--files",
    "App.tsx, B.tsx",
    "--accept",
    "bun test App.test.tsx",
    "--dir",
    "/proj",
  ]);

  expect(a.task).toBe("add a clear button");
  expect(a.files).toEqual(["App.tsx", "B.tsx"]);
  expect(a.accept).toBe("bun test App.test.tsx");
  expect(a.dir).toBe("/proj");
  expect(isOneShot(a)).toBe(true);
});

test("isOneShot is false unless task + files + gate are all present", () => {
  // These now parse fine (interactive mode); they just aren't one-shot.
  expect(isOneShot(parseArgs(["do a thing"]))).toBe(false); // no --files/--accept
  expect(isOneShot(parseArgs(["--files", "a.ts", "--accept", "x"]))).toBe(
    false
  ); // no task
  expect(isOneShot(parseArgs(["task", "--files", "a.ts"]))).toBe(false); // no --accept
});

test("bare invocation parses to an empty interactive session", () => {
  const a = parseArgs([]);

  expect(a.task).toBe("");
  expect(a.files).toEqual([]);
  expect(a.accept).toBe("");
  expect(isOneShot(a)).toBe(false);
});

test("plan approval is narrow — a 'yes' answering a question must not implement", async () => {
  const { isPlanApproval, isApproval } = await import("../src/cli");

  expect(isPlanApproval("approve")).toBe(true);
  expect(isPlanApproval("Approved.")).toBe(true);
  expect(isPlanApproval("go")).toBe(true);
  expect(isPlanApproval("lgtm")).toBe(true);
  expect(isPlanApproval("implement")).toBe(true);

  expect(isPlanApproval("yes")).toBe(false);
  expect(isPlanApproval("y")).toBe(false);
  expect(isPlanApproval("ok")).toBe(false);
  expect(isPlanApproval("looks good, also add tests")).toBe(false);

  // The staged-web checkpoint keeps the wide form (it prompted "type 'approve'").
  expect(isApproval("yes")).toBe(true);
  expect(isApproval("ok")).toBe(true);
});
