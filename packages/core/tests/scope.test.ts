import { test, expect } from "bun:test";
import {
  isInScope,
  isVendored,
  writable,
  normalizeWorkspacePath,
} from "../src/lib/scope";

test("isVendored blocks SDK/UI/mock/generated files, allows model files", () => {
  expect(isVendored("src/lib/use-resource.ts")).toBe(true);
  expect(isVendored("src/components/ui/button.tsx")).toBe(true);
  expect(isVendored("src/mocks/db.ts")).toBe(true);
  expect(isVendored("src/mocks/browser.ts")).toBe(true);
  expect(isVendored("src/routeTree.gen.ts")).toBe(true);
  // Model-owned files are NOT vendored.
  expect(isVendored("src/mocks/handlers.ts")).toBe(false);
  expect(isVendored("src/views/Deals/index.tsx")).toBe(false);
  expect(isVendored("src/views/Deals/deals.constants.ts")).toBe(false);
});

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
