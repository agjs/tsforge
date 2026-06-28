import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit, applyEdits } from "../src/files/edit";
import { doEdit } from "../src/loop/tools/file-ops";
import type { IToolContext } from "../src/loop/tools/tool-context";

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

test("same-content edit is ok but flagged changed:false (no-op, not a mutation)", async () => {
  const dir = await tmp({ "a.ts": "export const x = 1;\n" });

  try {
    const single = await applyEdit(dir, {
      file: "a.ts",
      oldString: "const x = 1;",
      newString: "const x = 1;", // identical → no real change
    });

    expect(single).toMatchObject({ ok: true, changed: false });

    const batch = await applyEdits(dir, "a.ts", [
      { oldString: "const x = 1;", newString: "const x = 1;" },
    ]);

    expect(batch).toMatchObject({ ok: true, changed: false });

    // The file is left byte-identical.
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe(
      "export const x = 1;\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real edit reports changed:true", async () => {
  const dir = await tmp({ "a.ts": "export const x = 1;\n" });

  try {
    const single = await applyEdit(dir, {
      file: "a.ts",
      oldString: "= 1",
      newString: "= 2",
    });

    expect(single).toMatchObject({ ok: true, changed: true });

    const batch = await applyEdits(dir, "a.ts", [
      { oldString: "= 2", newString: "= 3" },
    ]);

    expect(batch).toMatchObject({ ok: true, count: 1, changed: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fuzzy edit preserves CRLF line endings (no mixed endings) — issue #24", async () => {
  // CRLF file; oldString has wrong indentation so the exact match misses and the
  // fuzzy (trim-normalized) fallback fires. The result must stay all-CRLF.
  const dir = await tmp({ "crlf.ts": "line1\r\n\tindented2\r\nline3\r\n" });

  try {
    // applyEdits carries the indentation-tolerant fuzzy fallback; the missing
    // tab + missing \r makes the exact match miss and the fuzzy path fire.
    const r = await applyEdits(dir, "crlf.ts", [
      { oldString: "line1\nindented2", newString: "line1\nINDENTED2" },
    ]);

    expect(r.ok).toBe(true);

    const out = await Bun.file(join(dir, "crlf.ts")).text();

    expect(out).toContain("INDENTED2");
    // After stripping every proper CRLF pair, no lone \n may remain.
    expect(out.replace(/\r\n/g, "").includes("\n")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fuzzy edit tolerates a prettier trailing comma (multiline literal)", async () => {
  // Prettier added a trailing comma after `b: 2`. The model's oldString ends the
  // window at `b: 2` (no comma), so the EXACT match misses (`b: 2\n}` ≠ `b: 2,\n}`);
  // only the comma-tolerant fuzzy path can match.
  const dir = await tmp({ "a.ts": "const o = {\n  a: 1,\n  b: 2,\n};\n" });

  try {
    const r = await applyEdits(dir, "a.ts", [
      { oldString: "  a: 1,\n  b: 2\n}", newString: "  a: 1,\n  b: 3\n}" },
    ]);

    expect(r.ok).toBe(true);
    expect(await Bun.file(join(dir, "a.ts")).text()).toContain("b: 3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fuzzy edit tolerates semicolon-style drift", async () => {
  // File has trailing semicolons (prettier); the model's multi-line oldString
  // omits them, so the exact match misses and the semicolon-tolerant fuzzy fires.
  const dir = await tmp({ "a.ts": "const a = 1;\nconst b = 2;\n" });

  try {
    const r = await applyEdits(dir, "a.ts", [
      {
        oldString: "const a = 1\nconst b = 2",
        newString: "const a = 1\nconst b = 99",
      },
    ]);

    expect(r.ok).toBe(true);
    expect(await Bun.file(join(dir, "a.ts")).text()).toContain("const b = 99");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fuzzy delete (empty newString) removes the matched lines, no blank line", async () => {
  // Wrong indentation forces the fuzzy path; an empty newString should DELETE
  // the matched line, not replace it with a blank line.
  const dir = await tmp({ "a.ts": "keep1\n    a\n    b\nkeep2\n" });

  try {
    // "a\nb" isn't a substring (content indents b), so the exact match misses and
    // the fuzzy path deletes lines a+b. The result must NOT contain a blank line.
    const r = await applyEdits(dir, "a.ts", [
      { oldString: "a\nb", newString: "" },
    ]);

    expect(r).toMatchObject({ ok: true });
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe("keep1\nkeep2\n");
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

test("applyEdits falls back to indentation-tolerant match when exact fails", async () => {
  // File has 4-space indent; the model's oldString uses 2-space — exact match
  // fails, but the line content is identical → fuzzy fallback applies it.
  const dir = await tmp({
    "a.ts": "function f() {\n    const x = arr[i];\n    return x;\n}\n",
  });

  try {
    const r = await applyEdits(dir, "a.ts", [
      {
        oldString: "  const x = arr[i];\n  return x;",
        newString: "  return arr[i] ?? 0;",
      },
    ]);

    expect(r).toMatchObject({ ok: true, count: 1 });
    const text = await Bun.file(join(dir, "a.ts")).text();

    expect(text).toContain("return arr[i] ?? 0;");
    expect(text).not.toContain("const x = arr[i]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fuzzy fallback tolerates quote-style drift (single vs double)", async () => {
  // The file (prettier) uses double quotes; the model wrote the oldString with
  // single quotes — the dominant local-model edit miss. Should still match.
  const dir = await tmp({
    "a.ts": 'import { IUser } from "@/features/users/users.types";\n',
  });

  try {
    const r = await applyEdits(dir, "a.ts", [
      {
        oldString: "import { IUser } from '@/features/users/users.types';",
        newString: "import type { IUser } from '@/features/users/users.types';",
      },
    ]);

    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(await Bun.file(join(dir, "a.ts")).text()).toContain(
      "import type { IUser }"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fuzzy fallback tolerates Unicode drift (smart quotes, NBSP, en-dash)", async () => {
  // File has ASCII straight quotes + normal spaces; the model emitted smart quotes,
  // a non-breaking space, and an en-dash (common in LLM/pasted output).
  const dir = await tmp({
    "a.ts": 'const label = "A - B";\nconst path = "@/x";\n',
  });

  try {
    const r = await applyEdits(dir, "a.ts", [
      {
        // “ ” smart quotes, NBSP between A/B, en-dash – instead of hyphen.
        oldString: "const label = “A – B”;",
        newString: 'const label = "A then B";',
      },
    ]);

    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(await Bun.file(join(dir, "a.ts")).text()).toContain("A then B");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fuzzy fallback tolerates internal-whitespace drift", async () => {
  const dir = await tmp({ "a.ts": "const sum = foo(a, b);\n" });

  try {
    const r = await applyEdits(dir, "a.ts", [
      // Model's oldString has different internal spacing inside the call.
      {
        oldString: "const sum = foo( a,b );",
        newString: "const sum = bar(a, b);",
      },
    ]);

    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(await Bun.file(join(dir, "a.ts")).text()).toContain("bar(a, b)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fuzzy fallback does NOT guess when the line-match is ambiguous", async () => {
  const dir = await tmp({ "a.ts": "  doThing();\n\n  doThing();\n" });

  try {
    const r = await applyEdits(dir, "a.ts", [
      { oldString: "doThing();", newString: "doOther();" },
    ]);

    // Exact match is ambiguous (2 occurrences) → reported, not guessed.
    expect(r).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(await Bun.file(join(dir, "a.ts")).text()).toContain("doThing();");
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

// A not-found edit (stale anchor after auto-format) inlines the file's CURRENT
// content into the rejection, so the model repairs it in the SAME turn instead
// of spending one on a re-`read` — the model's #1 reported friction.
test("not-found edit rejection carries the file's current content", async () => {
  const dir = await tmp({ "a.ts": "const x = 1;\nconst y = 2;\n" });
  const ctx: IToolContext = {
    cwd: dir,
    files: ["**/*.ts"],
    task: "t",
    report: () => undefined,
  };

  try {
    const msg = await doEdit(
      { file: "a.ts", oldString: "const z = 99;", newString: "const z = 0;" },
      ctx
    );

    expect(msg).toContain("REJECTED");
    expect(msg).toContain("CURRENT content is below");
    // The actual current lines are present so the model can copy oldString verbatim.
    expect(msg).toContain("const x = 1;");
    expect(msg).toContain("const y = 2;");
    // And it does NOT tell the model to go `read` the file (content is inline).
    expect(msg).not.toContain("`read` a.ts to see");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
