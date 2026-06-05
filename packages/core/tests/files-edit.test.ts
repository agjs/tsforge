import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit, applyEdits } from "../src/files/edit";

async function tmp(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-edit-"));

  for (const [name, content] of Object.entries(files)) {
    await Bun.write(join(dir, name), content);
  }

  return dir;
}

test("replaces a unique occurrence and writes the file", async () => {
  const dir = await tmp({ "a.ts": "export const x = 1;\n" });

  try {
    const r = await applyEdit(dir, {
      file: "a.ts",
      oldString: "= 1",
      newString: "= 2",
    });

    expect(r.ok).toBe(true);
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(
      "export const x = 2;\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("not-found when oldString is absent", async () => {
  const dir = await tmp({ "a.ts": "hello" });

  try {
    const r = await applyEdit(dir, {
      file: "a.ts",
      oldString: "nope",
      newString: "x",
    });

    expect(r).toMatchObject({ ok: false, reason: "not-found" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ambiguous when oldString matches more than once; file unchanged", async () => {
  const dir = await tmp({ "a.ts": "a\na\n" });

  try {
    const r = await applyEdit(dir, {
      file: "a.ts",
      oldString: "a",
      newString: "b",
    });

    expect(r).toMatchObject({ ok: false, reason: "ambiguous", matches: 2 });
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe("a\na\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing-file when the target does not exist", async () => {
  const dir = await tmp({});

  try {
    const r = await applyEdit(dir, {
      file: "nope.ts",
      oldString: "x",
      newString: "y",
    });

    expect(r).toMatchObject({ ok: false, reason: "missing-file" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyEdits fixes the same issue at several sites in one call", async () => {
  // The money case: two `new Array(n).fill(...)` sites, fixed together.
  const dir = await tmp({
    "money.ts": [
      "const a = new Array(n).fill(0);",
      "const b = new Array(n).fill(base);",
    ].join("\n"),
  });

  try {
    const r = await applyEdits(dir, "money.ts", [
      {
        oldString: "new Array(n).fill(0)",
        newString: "Array.from({ length: n }, () => 0)",
      },
      {
        oldString: "new Array(n).fill(base)",
        newString: "Array.from({ length: n }, () => base)",
      },
    ]);

    expect(r).toMatchObject({ ok: true, count: 2 });
    const text = await Bun.file(join(dir, "money.ts")).text();

    expect(text).not.toContain("new Array(");
    expect(text.split("Array.from").length - 1).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyEdits is atomic: one bad replacement writes NOTHING", async () => {
  const original = "const a = 1;\nconst b = 2;\n";
  const dir = await tmp({ "a.ts": original });

  try {
    const r = await applyEdits(dir, "a.ts", [
      { oldString: "= 1", newString: "= 10" }, // valid
      { oldString: "= 999", newString: "= 0" }, // not present → whole batch fails
    ]);

    expect(r).toMatchObject({ ok: false, index: 1, reason: "not-found" });
    // The valid first edit must NOT have been written — all-or-nothing.
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyEdits sees the result of earlier replacements (sequential)", async () => {
  const dir = await tmp({ "a.ts": "x" });

  try {
    const r = await applyEdits(dir, "a.ts", [
      { oldString: "x", newString: "y" },
      { oldString: "y", newString: "z" }, // matches the output of the first
    ]);

    expect(r).toMatchObject({ ok: true, count: 2 });
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe("z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
