import { test, expect } from "bun:test";
import {
  isInScope,
  isVendored,
  writable,
  normalizeWorkspacePath,
  WEB_VENDORED_PATTERNS,
} from "../src/lib/scope";

test("only the generated route tree is vendored; everything else is editable", () => {
  const p = WEB_VENDORED_PATTERNS;

  // The ONE untouchable file: the build-regenerated route tree.
  expect(isVendored("src/routeTree.gen.ts", p)).toBe(true);

  // The old vendored SDK is gone — those files (api/use-resource/result/mocks)
  // are no longer scaffolded, and src/lib is now ordinary editable code.
  expect(isVendored("src/lib/utils.ts", p)).toBe(false); // cn() — clean, editable
  expect(isVendored("src/lib/format.ts", p)).toBe(false); // model's own helper
  expect(isVendored("src/components/ui/card.tsx", p)).toBe(false);
  expect(isVendored("src/components/ui/button.tsx", p)).toBe(false);
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
