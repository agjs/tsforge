import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAndPersistMap,
  loadMap,
  recallMapBlock,
  serializeMapBlock,
  forgetMap,
} from "../src/codebase";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tsforge-map-"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    '{"compilerOptions":{"strict":true,"skipLibCheck":true,"moduleResolution":"bundler"},"include":["*.ts"]}'
  );
  // a.ts is the hub: imported by both b.ts and c.ts.
  writeFileSync(
    join(dir, "a.ts"),
    "export const foo = 1;\nexport function bar(): number {\n  return foo;\n}\n"
  );
  writeFileSync(
    join(dir, "b.ts"),
    'import { foo } from "./a";\nexport const x = foo;\n'
  );
  writeFileSync(
    join(dir, "c.ts"),
    'import { bar } from "./a";\nexport const y = bar();\n'
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("builds an import graph and ranks hubs by in-degree", async () => {
  const map = await buildAndPersistMap(dir);

  expect(map).not.toBeNull();
  expect(map?.modules["a.ts"]?.exports).toEqual(["foo", "bar"]);
  expect(map?.modules["b.ts"]?.imports).toContain("a.ts");
  // a.ts is imported by b.ts and c.ts → top hub with in-degree 2.
  expect(map?.hubs[0]?.path).toBe("a.ts");
  expect(map?.hubs[0]?.importedBy).toBe(2);
});

test("serializes a prompt block with hubs and a staleness note", async () => {
  const map = await buildAndPersistMap(dir);
  const block = serializeMapBlock(map!);

  expect(block).toContain("WORKSPACE_MAP:");
  expect(block).toContain("a.ts");
  expect(block).toContain("hubs");
  expect(block).toContain("Map built");
});

test("recall returns the block, and flags drift after an edit", async () => {
  await buildAndPersistMap(dir);

  const fresh = await recallMapBlock(dir);

  expect(fresh).toContain("WORKSPACE_MAP:");
  expect(fresh).toContain("no changes since");

  writeFileSync(join(dir, "a.ts"), "export const foo = 2;\n"); // drift
  const stale = await recallMapBlock(dir);

  expect(stale).toContain("1 file(s) changed since");
});

test("persisted map is gitignored under .tsforge", async () => {
  await buildAndPersistMap(dir);
  const ignore = await Bun.file(join(dir, ".tsforge", ".gitignore")).text();

  expect(ignore).toContain("workspace-map.json");
});

test("no tsconfig → null (nothing to map); no map → empty recall", async () => {
  const bare = mkdtempSync(join(tmpdir(), "tsforge-bare-"));

  try {
    expect(await buildAndPersistMap(bare)).toBeNull();
    expect(await recallMapBlock(bare)).toBe("");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("forget deletes the persisted map", async () => {
  await buildAndPersistMap(dir);
  expect(await loadMap(dir)).not.toBeNull();
  expect(await forgetMap(dir)).toBe(true);
  expect(await loadMap(dir)).toBeNull();
});
