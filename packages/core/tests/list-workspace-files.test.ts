import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceFiles } from "../src/lib/fs";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tsforge-lwf-"));

  // Write three files, then stamp distinct mtimes (oldest → newest).
  for (const name of ["old.ts", "mid.ts", "new.ts"]) {
    await writeFile(join(dir, name), "export const x = 1;\n");
  }

  await utimes(join(dir, "old.ts"), new Date(1_000), new Date(1_000));
  await utimes(join(dir, "mid.ts"), new Date(2_000), new Date(2_000));
  await utimes(join(dir, "new.ts"), new Date(3_000), new Date(3_000));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("listWorkspaceFiles: orders most-recently-modified first", async () => {
  expect(await listWorkspaceFiles(dir)).toEqual(["new.ts", "mid.ts", "old.ts"]);
});
