import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotFiles, restoreFiles } from "../src/loop";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tsforge-snap-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Regression: review-repair's default scope is the whole-repo glob `**/*`. A
// literal `Bun.file("**/*")` never exists, so without glob expansion the snapshot
// was empty and restore was a silent no-op — a broken revert by default.
test("snapshotFiles expands a glob scope (not a literal path)", async () => {
  const snap = await snapshotFiles(dir, ["**/*"]);

  expect(snap.existed.has("src/a.ts")).toBe(true);
  expect(snap.existed.has("src/b.ts")).toBe(true);
  expect(snap.contents.get("src/a.ts")).toContain("export const a = 1;");
});

test("restoreFiles rolls a glob-scoped edit batch back verbatim", async () => {
  const snap = await snapshotFiles(dir, ["**/*"]);

  writeFileSync(join(dir, "src", "a.ts"), "// CLOBBERED\n");
  await restoreFiles(snap);

  expect(readFileSync(join(dir, "src", "a.ts"), "utf8")).toBe(
    "export const a = 1;\n"
  );
});

// Regression: a failed repair that CREATED a helper/test file used to leave it
// behind, because restore only rewrote pre-existing files. Restore now tombstones
// files that appeared in scope after the snapshot.
test("restoreFiles tombstones files created after the snapshot", async () => {
  const snap = await snapshotFiles(dir, ["**/*"]);

  writeFileSync(join(dir, "src", "a.ts"), "// edited\n");
  writeFileSync(join(dir, "src", "helper.ts"), "// newly created\n");
  mkdirSync(join(dir, "src", "sub"));
  writeFileSync(join(dir, "src", "sub", "deep.ts"), "// nested new\n");

  await restoreFiles(snap);

  // edited file rolled back
  expect(readFileSync(join(dir, "src", "a.ts"), "utf8")).toBe(
    "export const a = 1;\n"
  );
  // created files removed (flat and nested)
  expect(existsSync(join(dir, "src", "helper.ts"))).toBe(false);
  expect(existsSync(join(dir, "src", "sub", "deep.ts"))).toBe(false);
  // pre-existing untouched file survives
  expect(existsSync(join(dir, "src", "b.ts"))).toBe(true);
});

// Regression: the prompt-facing resolver skips binaries/assets (.svg, images),
// so tombstoning through it left a failed repair's created icon.svg on disk.
// Rollback must use the binary-inclusive resolver.
test("restoreFiles tombstones a created binary/asset file (svg)", async () => {
  const snap = await snapshotFiles(dir, ["**/*"]);

  writeFileSync(join(dir, "src", "icon.svg"), "<svg></svg>");
  writeFileSync(join(dir, "logo.png"), "PNGDATA");

  await restoreFiles(snap);

  expect(existsSync(join(dir, "src", "icon.svg"))).toBe(false);
  expect(existsSync(join(dir, "logo.png"))).toBe(false);
});

test("restoreFiles preserves a PRE-EXISTING asset file (not tombstoned)", async () => {
  writeFileSync(join(dir, "src", "keep.svg"), "<svg>keep</svg>");

  const snap = await snapshotFiles(dir, ["**/*"]);

  writeFileSync(join(dir, "src", "new.ts"), "// new\n");
  await restoreFiles(snap);

  // the asset that existed at snapshot time survives; the new .ts is tombstoned
  expect(existsSync(join(dir, "src", "keep.svg"))).toBe(true);
  expect(existsSync(join(dir, "src", "new.ts"))).toBe(false);
});

test("a literal scope still snapshots exactly those files", async () => {
  const snap = await snapshotFiles(dir, ["src/a.ts"]);

  expect([...snap.contents.keys()]).toEqual(["src/a.ts"]);
});
