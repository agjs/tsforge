import { test, expect } from "bun:test";
import {
  isInScope,
  writable,
  insideWorkspace,
  normalizeWorkspacePath,
} from "../src/lib/scope";
import { isWin32 } from "../src/lib/platform";

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

  // A `.tsx`/`.jsx` source is commonly tested by a plain `.test.ts` — match on the
  // stem across source extensions, not the test file's own extension.
  expect(writable("src/Component.test.ts", ["src/Component.tsx"])).toBe(true);
  expect(writable("Widget.test.ts", ["Widget.jsx"])).toBe(true);

  // But NOT a test whose source is out of scope — no arbitrary test writes.
  expect(writable("pricing.test.ts", scope)).toBe(false);
  expect(writable("evil.test.ts", scope)).toBe(false);

  // Only REAL test-file extensions count — a bogus `.mjsx`/`.mtsx` must not be
  // treated as a test of `lexer` and slip into the writable set.
  expect(writable("lexer.test.mjsx", scope)).toBe(false);
  expect(writable("lexer.test.mtsx", scope)).toBe(false);
  // …but the valid module variants do.
  expect(writable("lexer.test.mts", scope)).toBe(true);
  expect(writable("lexer.spec.js", scope)).toBe(true);

  // The source file itself is still writable; isInScope stays literal (sibling
  // allowance lives in writable, not isInScope).
  expect(writable("lexer.ts", scope)).toBe(true);
  expect(isInScope("lexer.test.ts", scope)).toBe(false);
});

// insideWorkspace decides whether the shell-redirect guard looks at a target at
// all, so a false negative SKIPS the guard — it must fail closed, treating a path
// as inside unless a `..` SEGMENT or an absolute root proves otherwise.
test("insideWorkspace compares path segments, not prefixes", () => {
  // Ordinary filenames that merely begin with dots are INSIDE.
  for (const file of ["..secret.ts", "...rc", "..", ".." + "x"]) {
    expect({ file, inside: insideWorkspace(file) }).toEqual({
      file,
      inside: file !== "..",
    });
  }

  // Real escapes and absolute paths are OUTSIDE.
  for (const file of [
    "../escaped.ts",
    "../../x",
    "a/../../b.ts",
    "/etc/passwd",
  ]) {
    expect({ file, inside: insideWorkspace(file) }).toEqual({
      file,
      inside: false,
    });
  }

  // Plain in-workspace paths are inside.
  for (const file of ["src/x.ts", "x.ts", "a/b/c.tsx"]) {
    expect({ file, inside: insideWorkspace(file) }).toEqual({
      file,
      inside: true,
    });
  }
});

// writable() and insideWorkspace() must apply the SAME segment rule. writable used
// its own startsWith("..") test, which (a) made every ordinary name beginning with
// two dots unwritable through every edit tool, and (b) because the shell-redirect
// guard reads writable, let `run` create such a file even under a scope as broad as
// ["**/*"] — the very bypass that guard exists to close.
test("writable and insideWorkspace agree on what escapes the workspace", () => {
  const CASES: readonly [string, boolean][] = [
    // Ordinary filenames that merely begin with dots — INSIDE, so writable
    // whenever the scope matches.
    ["..secret.ts", true],
    ["...rc", true],
    ["..x", true],
    // Real escapes and absolute paths.
    ["../escaped.ts", false],
    ["..", false],
    ["a/../b.ts", false],
    ["/etc/passwd", false],
  ];

  for (const [file, allowed] of CASES) {
    expect({ file, inside: insideWorkspace(file) }).toEqual({
      file,
      inside: allowed,
    });
    expect({ file, writable: writable(file, ["**/*"]) }).toEqual({
      file,
      writable: allowed,
    });
  }
});

// What counts as absolute is platform-dependent, so this pins the semantics of the
// platform the suite runs on. Hand-rolling the check instead of using
// node:path.isAbsolute failed OPEN on POSIX: `D:/secret.ts` is an ordinary relative
// path there (a directory named `D:`), and calling it absolute skipped the
// shell-write guard for a real workspace file.
test("insideWorkspace uses this platform's notion of absolute", () => {
  const windowsForms = [
    "D:/secret.ts",
    "D:\\secret.ts",
    "\\\\server\\share\\x.ts",
  ];

  for (const file of windowsForms) {
    expect({ file, inside: insideWorkspace(file) }).toEqual({
      file,
      // On Windows these are absolute (outside); on POSIX they are ordinary
      // relative names (inside) and MUST stay guarded.
      inside: !isWin32(),
    });
  }

  // Always outside, on every platform.
  for (const file of ["/etc/passwd", "../escaped.ts", "a/../b.ts"]) {
    expect({ file, inside: insideWorkspace(file) }).toEqual({
      file,
      inside: false,
    });
  }
});
