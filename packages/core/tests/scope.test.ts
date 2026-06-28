import { test, expect } from "bun:test";
import { isInScope, writable, normalizeWorkspacePath } from "../src/lib/scope";

// The vendored "you cannot edit this file" concept was removed entirely — a model
// may edit anything in scope, including generated files (the build regenerates
// `*.gen.ts` anyway). Scope + traversal safety are all that remain below.

test("matches exact paths and globs; empty patterns match nothing", () => {
  expect(isInScope("todo.ts", ["todo.ts"])).toBe(true);
  expect(isInScope("todo.test.ts", ["todo.ts"])).toBe(false);
  expect(isInScope("src/a/b.ts", ["src/**"])).toBe(true);
  expect(isInScope("x.ts", [])).toBe(false);
});

test("normalizeWorkspacePath leaves a plain relative path alone", () => {
  expect(normalizeWorkspacePath("/agjs/code/app", "src/app.ts")).toBe(
    "src/app.ts"
  );
  expect(normalizeWorkspacePath("/agjs/code/app", "tsconfig.json")).toBe(
    "tsconfig.json"
  );
});

test("normalizeWorkspacePath strips a redundant repeat of the workspace", () => {
  // The real footgun: model passed the whole relative path while cwd was that dir.
  expect(
    normalizeWorkspacePath(
      "/agjs/code/stream-harness-test",
      "agjs/code/stream-harness-test/tsconfig.json"
    )
  ).toBe("tsconfig.json");
});

test("normalizeWorkspacePath strips an absolute path inside the workspace", () => {
  expect(
    normalizeWorkspacePath("/agjs/code/app", "/agjs/code/app/src/x.ts")
  ).toBe("src/x.ts");
});

test("a path escaping the workspace is not writable (no traversal)", () => {
  const out = normalizeWorkspacePath("/agjs/code/app", "../other/x.ts");

  expect(out).toBe("../other/x.ts");
  // `**/*` glob-matches `../other/x.ts`, so `writable` must reject it explicitly.
  expect(writable(out, ["**/*"])).toBe(false);
  expect(writable("/etc/passwd", ["**/*"])).toBe(false);
});

// Regression: the gate's `test-sibling-required` rule makes the model add a
// co-located test for any source it changes — so the editable scope must implicitly
// allow that test sibling, or the rule demands a file the scope forbids and the
// model stalls to the cycle cap (observed live on multi-file specs: `lexer.ts` in
// scope, but `lexer.test.ts` rejected → deadlock).
test("writable allows the co-located test sibling of an in-scope source", () => {
  // Multi-file spec scope: only the sources are listed.
  const scope = ["lexer.ts", "parser.ts", "executor.ts", "query.ts"];

  expect(writable("lexer.test.ts", scope)).toBe(true);
  expect(writable("parser.test.ts", scope)).toBe(true);
  expect(writable("src/a.spec.tsx", ["src/a.tsx"])).toBe(true);

  // But NOT a test whose source is out of scope — no arbitrary test writes.
  expect(writable("pricing.test.ts", scope)).toBe(false);
  expect(writable("evil.test.ts", scope)).toBe(false);

  // The source file itself is still writable; isInScope stays literal (sibling
  // allowance lives in writable, not isInScope).
  expect(writable("lexer.ts", scope)).toBe(true);
  expect(isInScope("lexer.test.ts", scope)).toBe(false);
});
