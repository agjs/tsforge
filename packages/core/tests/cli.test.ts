import { test, expect } from "bun:test";
import { parseArgs } from "../src/cli";

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

  expect(a).not.toBeNull();
  expect(a?.task).toBe("add a clear button");
  expect(a?.files).toEqual(["App.tsx", "B.tsx"]);
  expect(a?.accept).toBe("bun test App.test.tsx");
  expect(a?.dir).toBe("/proj");
});

test("returns null when required args are missing", () => {
  expect(parseArgs(["do a thing"])).toBeNull(); // no --files/--accept
  expect(parseArgs(["--files", "a.ts", "--accept", "x"])).toBeNull(); // no task
  expect(parseArgs(["task", "--files", "a.ts"])).toBeNull(); // no --accept
});
