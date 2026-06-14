import { test, expect } from "bun:test";
import {
  isInScope,
  isVendored,
  writable,
  normalizeWorkspacePath,
  WEB_VENDORED_PATTERNS,
} from "../src/lib/scope";

test("isVendored protects shipped SDK/generated files, frees model files", () => {
  const p = WEB_VENDORED_PATTERNS;

  // The untouchable shipped SDK + generated files.
  expect(isVendored("src/lib/use-resource.ts", p)).toBe(true);
  expect(isVendored("src/lib/api.ts", p)).toBe(true);
  expect(isVendored("src/mocks/db.ts", p)).toBe(true);
  expect(isVendored("src/mocks/browser.ts", p)).toBe(true);
  expect(isVendored("src/routeTree.gen.ts", p)).toBe(true);

  // Files the GUIDANCE tells the model to write must be ALLOWED.
  expect(isVendored("src/components/ui/card.tsx", p)).toBe(false); // new primitive
  expect(isVendored("src/components/ui/button.tsx", p)).toBe(false); // editable primitive
  expect(isVendored("src/lib/format.ts", p)).toBe(false); // new helper
  expect(isVendored("src/mocks/handlers.ts", p)).toBe(false); // model's mock registry
  expect(isVendored("src/views/Deals/index.tsx", p)).toBe(false);
});

test("isVendored is inert with no patterns (non-web / normal repos unaffected)", () => {
  expect(isVendored("src/lib/use-resource.ts", [])).toBe(false);
  expect(isVendored("src/lib/sort.ts", [])).toBe(false);
  expect(isVendored("anything.gen.ts", [])).toBe(false);
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
