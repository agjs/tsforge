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

// Regression (panel): a dependency spray rewrites bun.lockb — a BINARY. A string content map
// can't hold it (the size/binary skip left it in `existed` only), so restore left the sprayed
// lockfile on disk while reporting "reverted". It must be backed by RAW BYTES and restored.
test("restoreFiles faithfully restores a mutated BINARY lockfile (raw bytes)", async () => {
  const orig = new Uint8Array([0, 1, 2, 255, 254, 0, 42]);

  writeFileSync(join(dir, "bun.lockb"), orig);

  const snap = await snapshotFiles(dir, ["**/*"]);

  // Binary → backed by raw bytes, NOT the text content map.
  expect(snap.raw.has("bun.lockb")).toBe(true);
  expect(snap.contents.has("bun.lockb")).toBe(false);

  writeFileSync(join(dir, "bun.lockb"), new Uint8Array([9, 9, 9])); // the spray
  await restoreFiles(snap);

  expect(new Uint8Array(readFileSync(join(dir, "bun.lockb")))).toEqual(orig);
});

// Regression (panel): a large package-lock.json exceeds MAX_SNAPSHOT_BYTES (128KB), so the
// content map silently dropped it and restore was a no-op. Oversize text is now raw-backed too.
test("restoreFiles faithfully restores a mutated OVERSIZE text file (raw bytes)", async () => {
  const big = "x".repeat(131_073); // just over MAX_SNAPSHOT_BYTES

  writeFileSync(join(dir, "package-lock.json"), big);

  const snap = await snapshotFiles(dir, ["**/*"]);

  expect(snap.raw.has("package-lock.json")).toBe(true);
  expect(snap.contents.has("package-lock.json")).toBe(false);

  writeFileSync(join(dir, "package-lock.json"), "SPRAYED");
  await restoreFiles(snap);

  expect(readFileSync(join(dir, "package-lock.json"), "utf8")).toBe(big);
});

// Regression (panel): with WS-B default-ON and a broad `**/*` scope, buffering EVERY binary
// with no ceiling could OOM the rollback. A file over MAX_RAW_SNAPSHOT_BYTES (8 MiB) is left
// existence-only — tracked so it isn't tombstoned, but not buffered.
test("snapshotFiles leaves a file over the raw cap existence-only (no OOM)", async () => {
  const huge = new Uint8Array(8_388_609); // 1 byte over 8 MiB

  writeFileSync(join(dir, "big.wasm"), huge);

  const snap = await snapshotFiles(dir, ["**/*"]);

  expect(snap.existed.has("big.wasm")).toBe(true); // still tracked (not wrongly tombstoned)
  expect(snap.raw.has("big.wasm")).toBe(false); // NOT buffered
  expect(snap.contents.has("big.wasm")).toBe(false);
  expect(snap.skipped.has("big.wasm")).toBe(true); // truncation surfaced, not silent
});

// Regression (panel): the per-file cap alone leaves TOTAL memory unbounded — many binaries
// each under the per-file cap would still all buffer and OOM. The aggregate budget stops
// raw-backing once the running total is exceeded; the rest go existence-only + `skipped`.
// (Caps are injected tiny here so the budget is exercised without writing 64 MiB to disk.)
test("snapshotFiles stops raw-backing at the AGGREGATE budget, surfacing the rest", async () => {
  // Three 1 KB binaries; a 2.2 KB total budget admits ~2, then stops.
  writeFileSync(join(dir, "a.bin"), new Uint8Array(1000));
  writeFileSync(join(dir, "b.bin"), new Uint8Array(1000));
  writeFileSync(join(dir, "c.bin"), new Uint8Array(1000));

  const snap = await snapshotFiles(dir, ["**/*"], { maxTotalBytes: 2200 });

  const raws = [...snap.raw.keys()].filter((k) => k.endsWith(".bin"));
  const skips = [...snap.skipped].filter((k) => k.endsWith(".bin"));

  expect(raws.length).toBeGreaterThanOrEqual(1); // some are backed…
  expect(raws.length).toBeLessThan(3); // …but the budget stopped it before all three
  expect(raws.length + skips.length).toBe(3); // every eligible file is raw OR skipped
  // The raw-backed entries are still faithfully restorable after the budget cutoff.
  const [kept] = raws;

  if (kept === undefined) {
    throw new Error("expected at least one raw-backed file");
  }

  writeFileSync(join(dir, kept), new Uint8Array([9, 9, 9])); // mutate a kept file
  await restoreFiles(snap);
  expect(readFileSync(join(dir, kept)).length).toBe(1000); // reverted to original size
});

// The contract `skipped` exists to expose: a file too large to back is NOT byte-reverted by
// restoreFiles. Callers (near-green rollback) read `skipped` to surface the incomplete revert.
test("restoreFiles does NOT revert a skipped (over-cap) file — the contract skipped exposes", async () => {
  writeFileSync(join(dir, "x.bin"), new Uint8Array(100));

  const snap = await snapshotFiles(dir, ["**/*"], { maxRawBytes: 10 }); // 100 > 10 → skipped

  expect(snap.skipped.has("x.bin")).toBe(true);
  expect(snap.raw.has("x.bin")).toBe(false);

  writeFileSync(join(dir, "x.bin"), new Uint8Array([1, 2, 3])); // a spray mutates it
  await restoreFiles(snap);

  // NOT reverted — existence-only. This is why rollback must surface `skipped`, not claim clean.
  expect(readFileSync(join(dir, "x.bin")).length).toBe(3);
});
