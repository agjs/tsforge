import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCreate } from "../src/files/create";

test("creates a new file (including nested dirs)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-create-"));

  try {
    const r = await applyCreate(dir, {
      file: "src/greet.ts",
      content: "export const x = 1;\n",
    });

    expect(r.ok).toBe(true);
    expect(await Bun.file(join(dir, "src/greet.ts")).text()).toBe(
      "export const x = 1;\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-create-"));

  try {
    await Bun.write(join(dir, "a.ts"), "original");
    const r = await applyCreate(dir, { file: "a.ts", content: "new" });

    expect(r).toMatchObject({ ok: false, reason: "exists" });
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe("original");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
