import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFilesOrRollback } from "../src/lib/fs";

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
