import { test, expect } from "bun:test";
import { resolveWritable } from "../src/loop/tools/tool-context";
import type { IToolContext } from "../src/loop/tools/execute-tool";

function ctx(files: string[]): IToolContext {
  return { cwd: "/tmp/proj", files, task: "t", report: () => undefined };
}

// resolveWritable is the single normalize-then-scope-check step behind every write
// path. Doing the two separately is what let organize_imports reject in-scope files
// the model addressed absolutely or as "./x", so both halves are pinned here
// directly rather than only through its callers.
test("resolveWritable normalizes before scope-checking", () => {
  const c = ctx(["src/**"]);

  for (const file of [
    "src/x.ts",
    "./src/x.ts",
    "/tmp/proj/src/x.ts",
    "src/./x.ts",
  ]) {
    expect({ file, ...resolveWritable(c, file) }).toEqual({
      file,
      path: "src/x.ts",
      writable: true,
    });
  }
});

test("resolveWritable refuses an out-of-scope path and one that escapes", () => {
  const c = ctx(["src/**"]);

  // Inside the workspace but not in scope: normalized, refused.
  expect(resolveWritable(c, "./secret.ts")).toEqual({
    path: "secret.ts",
    writable: false,
  });

  // Escapes the workspace: never writable, however it is spelled.
  for (const file of ["../escaped.ts", "/etc/passwd", "src/../../escaped.ts"]) {
    expect({ file, writable: resolveWritable(c, file).writable }).toEqual({
      file,
      writable: false,
    });
  }
});

// An ordinary filename that merely begins with dots is a normal workspace file:
// writable when the scope matches. A prefix test on ".." made these permanently
// unwritable through every edit tool.
test("resolveWritable treats a dotted-but-ordinary name as a normal file", () => {
  for (const file of ["..secret.ts", "...rc", "..x"]) {
    expect({ file, ...resolveWritable(ctx([file]), file) }).toEqual({
      file,
      path: file,
      writable: true,
    });
  }
});
