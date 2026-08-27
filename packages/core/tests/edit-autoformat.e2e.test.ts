import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFile } from "../src/gate";
import { applyEdits } from "../src/files/edit";

// e2e: the write-guard auto-formats a file (real eslint --fix + prettier) right
// after a write, so the model's next edit anchor no longer matches disk. This
// drives the REAL formatter (not a hand-built "formatted" string) and proves a
// pre-format anchor still lands via the widened fuzzy matcher — the local model's
// #1 reported friction. (A structural rewrite the fuzzy can't bridge falls back to
// the inlined-content rejection, covered in files-edit.test.ts.)
test("a pre-format edit anchor survives the real write-guard auto-format", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-fmt-e2e-"));
  const file = "demo.ts";
  // No trailing comma, no semicolons — the formatter will add both.
  const before = "const o = {\n  a: 1,\n  b: 2\n}\n";

  await Bun.write(join(dir, file), before);

  try {
    await formatFile(dir, file);
    const after = await Bun.file(join(dir, file)).text();

    // Sanity: the formatter actually reformatted (else the test proves nothing).
    expect(after).not.toBe(before);
    expect(after).toContain("b: 2,"); // prettier added the trailing comma

    // The model's pre-format anchor (`b: 2\n}`, no trailing comma) exact-misses the
    // formatted file (`b: 2,\n};`) — it must still apply via the fuzzy fallback,
    // NOT reject and force a re-read.
    const r = await applyEdits(dir, file, [
      { oldString: "  a: 1,\n  b: 2\n}", newString: "  a: 1,\n  b: 999\n}" },
    ]);

    expect(r.ok).toBe(true);
    expect(await Bun.file(join(dir, file)).text()).toContain("b: 999");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
