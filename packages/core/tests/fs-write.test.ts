import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFilesOrRollback, writeFileAtomic } from "../src/lib/fs";
import { readFileSync, readdirSync } from "node:fs";

test("writeFilesOrRollback writes every file on success (new + overwrite)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-batch-"));

  try {
    await mkdir(join(dir, "a"), { recursive: true });
    await writeFile(join(dir, "a/x.ts"), "old");

    const result = await writeFilesOrRollback(dir, [
      { path: "a/x.ts", content: "new" }, // overwrite
      { path: "a/y.ts", content: "fresh" }, // create
    ]);

    expect(result.ok).toBe(true);
    expect(await Bun.file(join(dir, "a/x.ts")).text()).toBe("new");
    expect(await Bun.file(join(dir, "a/y.ts")).text()).toBe("fresh");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a mid-batch failure rolls back: overwritten file RESTORED, new file removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-batch-"));

  try {
    await mkdir(join(dir, "a"), { recursive: true });
    await mkdir(join(dir, "b"), { recursive: true });
    await writeFile(join(dir, "a/x.ts"), "ORIGINAL");
    await chmod(join(dir, "b"), 0o555); // no write perm → second write throws

    // If perms aren't enforced (e.g. running as root), the failure can't be
    // simulated — skip the rollback assertions rather than false-pass.
    let enforced = false;

    try {
      await Bun.write(join(dir, "b/probe"), "x");
      await rm(join(dir, "b/probe"), { force: true });
    } catch {
      enforced = true;
    }

    if (!enforced) {
      return;
    }

    const result = await writeFilesOrRollback(dir, [
      { path: "a/x.ts", content: "CHANGED" }, // overwrite (must be restored)
      { path: "a/z.ts", content: "NEW" }, // create (must be removed)
      { path: "b/y.ts", content: "blocked" }, // fails → triggers rollback
    ]);

    expect(result.ok).toBe(false);
    // The overwritten file is RESTORED to its original (not deleted — no data loss).
    expect(await Bun.file(join(dir, "a/x.ts")).text()).toBe("ORIGINAL");
    // The newly-created file is removed (disk unchanged).
    expect(await Bun.file(join(dir, "a/z.ts")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "b/y.ts")).exists()).toBe(false);
  } finally {
    await chmod(join(dir, "b"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

// ── D2: writeFileAtomic — crash-atomic write via temp+rename ─────────────────
test("writeFileAtomic replaces a file without a torn intermediate + leaves no temp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-atomic-"));

  try {
    const f = join(dir, "x.ts");

    await writeFileAtomic(f, "const a = 1;\n");
    expect(readFileSync(f, "utf8")).toBe("const a = 1;\n");

    await writeFileAtomic(f, "const a = 2;\n");
    expect(readFileSync(f, "utf8")).toBe("const a = 2;\n");

    // No leftover .tmp sibling from either write.
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic creates missing parent dirs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-atomic-nested-"));

  try {
    await writeFileAtomic(join(dir, "a/b/c.ts"), "nested");
    expect(readFileSync(join(dir, "a/b/c.ts"), "utf8")).toBe("nested");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic under concurrent readers always yields a WHOLE version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-atomic-race-"));

  try {
    const f = join(dir, "big.ts");
    const vOld = "OLD".repeat(50_000) + "\n";
    const vNew = "NEW".repeat(50_000) + "\n";

    await writeFileAtomic(f, vOld);

    // Hammer reads while rewriting; every read must be one whole version, never
    // a truncated/half-written blend (the torn-write the old truncate-in-place
    // Bun.write could expose).
    const reads: string[] = [];
    const reader = (async () => {
      for (let i = 0; i < 200; i += 1) {
        reads.push(readFileSync(f, "utf8"));
        await Bun.sleep(0);
      }
    })();

    await writeFileAtomic(f, vNew);
    await reader;

    expect(reads.every((r) => r === vOld || r === vNew)).toBe(true);
    expect(readFileSync(f, "utf8")).toBe(vNew);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
