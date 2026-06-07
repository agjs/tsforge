import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFiles } from "../src/lib/fs";

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-readfiles-"));

  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
  await Bun.write(join(dir, "src", "a.ts"), "export const a = 1;\n");
  await Bun.write(join(dir, "src", "b.ts"), "export const b = 2;\n");
  await Bun.write(join(dir, "package.json"), "{}\n");
  await Bun.write(
    join(dir, "node_modules", "dep", "index.js"),
    "module.exports={}\n"
  );
  await Bun.write(join(dir, "logo.png"), "\x89PNG\r\n\x1a\n binary-ish");

  return dir;
}

test("readFiles expands a glob scope to real files (P1: not blind)", async () => {
  const dir = await fixture();

  try {
    const views = await readFiles(dir, ["**/*"]);
    const paths = views.map((v) => v.path);

    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
    expect(paths).toContain("package.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFiles glob skips node_modules and binary files", async () => {
  const dir = await fixture();

  try {
    const paths = (await readFiles(dir, ["**/*"])).map((v) => v.path);

    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths).not.toContain("logo.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFiles still reads literal paths and de-dupes overlap", async () => {
  const dir = await fixture();

  try {
    // A literal path plus a glob that also matches it → read once.
    const views = await readFiles(dir, ["src/a.ts", "src/*.ts"]);
    const aCount = views.filter((v) => v.path === "src/a.ts").length;

    expect(aCount).toBe(1);
    expect(views.map((v) => v.path)).toContain("src/b.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
