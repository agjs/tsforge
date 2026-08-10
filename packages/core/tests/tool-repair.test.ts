import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  repairArgs,
  coerceStringToArray,
  coerceStringValue,
  trimMarkdownFences,
  type IRepairResult,
} from "../src/agent/tool-repair";
import {
  toCreate,
  toEdits,
  diagnoseCreateArgs,
  diagnoseEditArgs,
} from "../src/agent/tools";
import { executeTool } from "../src/loop/tools/execute-tool";
import type { IToolContext } from "../src/loop/tools/execute-tool";

// ============================================================================
// L0: Lossless repairs (null-drop, autolink-unwrap)
// ============================================================================

test("L0: drops null/undefined values (model sends null for optional)", () => {
  const result = repairArgs({ file: "a.ts", limit: null });

  expect(result.args).toEqual({ file: "a.ts" });
  expect(result.applied).toContain("drop-null:limit");
  expect(result.recoverable).toBe(true);
});

test("L0: unwraps a degenerate markdown auto-link on a path (chat-leak)", () => {
  const result = repairArgs({ file: "[notes.md](notes.md)" });

  expect(result.args.file).toBe("notes.md");
  expect(result.applied).toContain("unwrap-autolink:file");
  expect(result.recoverable).toBe(true);
});

test("L0: unwraps an auto-link even with http(s) prefix", () => {
  const result = repairArgs({ file: "[notes.md](http://notes.md)" });

  expect(result.args.file).toBe("notes.md");
});

test("L0: leaves a REAL markdown link (distinct text/url) untouched", () => {
  const real = "[click here](https://example.com/page)";
  const result = repairArgs({ content: real });

  expect(result.args.content).toBe(real);
  expect(result.applied).toHaveLength(0);
});

test("L0: never rewrites valid free-text content (no greedy JSON parsing)", () => {
  const result = repairArgs({
    file: "a.ts",
    content: '["a","b"]',
  });

  expect(result.args.content).toBe('["a","b"]');
  expect(result.applied).toHaveLength(0);
});

test("L0: idempotent — already-valid args have no applied repairs", () => {
  const result = repairArgs({ file: "valid.ts", command: "tsc" });

  expect(result.applied).toHaveLength(0);
  expect(result.recoverable).toBe(true);
});

test("L0: unwraps nested arguments bag (double-wrapped tool call)", () => {
  const result = repairArgs({
    arguments: { file: "a.ts", content: "export {}\n" },
  });

  expect(result.applied).toContain("unwrap-nested:arguments");
  expect(result.args).toEqual({ file: "a.ts", content: "export {}\n" });
});

test("L0: unwraps nested omit-only stub (no file key)", () => {
  const result = repairArgs({
    arguments: { _harnessArgsOmitted: true },
  });

  expect(result.applied).toContain("unwrap-nested:arguments");
  expect(result.args).toEqual({ _harnessArgsOmitted: true });
});

test("L0: unwraps nested args / parameters synonyms", () => {
  expect(
    repairArgs({ args: { file: "a.ts", oldString: "x", newString: "y" } })
      .applied
  ).toContain("unwrap-nested:args");
  expect(
    repairArgs({
      parameters: { file: "a.ts", oldString: "x", newString: "y" },
    }).applied
  ).toContain("unwrap-nested:parameters");
});

test("L0: does not unwrap nest when top-level already has payload keys", () => {
  const result = repairArgs({
    file: "outer.ts",
    arguments: { file: "inner.ts", content: "nope" },
  });

  expect(result.applied.join(",")).not.toContain("unwrap-nested");
  expect(result.args.file).toBe("outer.ts");
});

// ============================================================================
// L1: Schema coercion — stringified arrays, numbers, booleans, markdown fences
// ============================================================================

test("L1: coerceStringToArray parses stringified JSON array", () => {
  const arr = coerceStringToArray('["a", "b"]');

  expect(arr).toEqual(["a", "b"]);
});

test("L1: coerceStringToArray returns null for non-array JSON", () => {
  const arr = coerceStringToArray('{"key": "value"}');

  expect(arr).toBeNull();
});

test("L1: coerceStringToArray returns null for non-string input", () => {
  expect(coerceStringToArray(123)).toBeNull();
  expect(coerceStringToArray([])).toBeNull();
});

test("L1: coerceStringToArray returns null for invalid JSON", () => {
  expect(coerceStringToArray("[incomplete")).toBeNull();
});

test("L1: coerceStringValue parses stringified number", () => {
  const n = coerceStringValue("42", "number");

  expect(n).toBe(42);
});

test("L1: coerceStringValue parses stringified boolean (true)", () => {
  const b = coerceStringValue("true", "boolean");

  expect(b).toBe(true);
});

test("L1: coerceStringValue parses stringified boolean (false)", () => {
  const b = coerceStringValue("false", "boolean");

  expect(b).toBe(false);
});

test("L1: coerceStringValue is case-insensitive for booleans", () => {
  expect(coerceStringValue("TRUE", "boolean")).toBe(true);
  expect(coerceStringValue("False", "boolean")).toBe(false);
});

test("L1: coerceStringValue returns null for invalid number strings", () => {
  expect(coerceStringValue("not-a-number", "number")).toBeNull();
  expect(coerceStringValue("Infinity", "number")).toBeNull();
});

test("L1: coerceStringValue returns null for invalid boolean strings", () => {
  expect(coerceStringValue("yes", "boolean")).toBeNull();
  expect(coerceStringValue("1", "boolean")).toBeNull();
});

test("L1: trimMarkdownFences strips code fence markers", () => {
  const trimmed = trimMarkdownFences("```path/to/file.ts```");

  expect(trimmed).toBe("path/to/file.ts");
});

test("L1: trimMarkdownFences trims surrounding whitespace", () => {
  const trimmed = trimMarkdownFences("  ```  path.ts  ```  ");

  expect(trimmed).toBe("path.ts");
});

test("L1: trimMarkdownFences returns null for non-string", () => {
  expect(trimMarkdownFences(123)).toBeNull();
  expect(trimMarkdownFences(null)).toBeNull();
});

test("L1: trimMarkdownFences returns plain string unchanged", () => {
  const plain = "plain/path.ts";

  expect(trimMarkdownFences(plain)).toBe(plain);
});

// ============================================================================
// L2: Safe defaults (none yet, deferred to telemetry)
// ============================================================================

// (Reserved for future safe-default rules)

// ============================================================================
// L3: Re-ask feedback (recoverable=false)
// ============================================================================

test("L3: recoverable flag is true by default (L0-L2 repairs)", () => {
  const result = repairArgs({ file: "[notes.md](notes.md)" });

  expect(result.recoverable).toBe(true);
});

// ============================================================================
// Integration: repair ladder end-to-end
// ============================================================================

test("repair ladder: multiple L0 repairs in one call", () => {
  const result = repairArgs({
    file: "[notes.md](notes.md)",
    limit: null,
    extra: undefined,
  });

  expect(result.args).toEqual({ file: "notes.md" });
  expect(result.applied).toContain("unwrap-autolink:file");
  expect(result.applied).toContain("drop-null:limit");
  expect(result.applied).toContain("drop-null:extra");
});

test("repair result is typed IRepairResult", () => {
  const result: IRepairResult = repairArgs({ file: "a.ts" });

  expect(result).toHaveProperty("args");
  expect(result).toHaveProperty("applied");
  expect(result).toHaveProperty("recoverable");
  expect(result.feedback).toBeUndefined(); // No L3 feedback yet
});

// ============================================================================
// Turn loop integration tests
// ============================================================================

function ctx(cwd: string, files: string[]): IToolContext {
  return { cwd, files, task: "t", report: () => undefined };
}

test("turn loop: malformed file path with markdown fences is coerced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-repair-"));

  try {
    await Bun.write(join(dir, "test.ts"), "const x = 1;\n");

    // Model wraps path in markdown fences
    const r = await executeTool(
      {
        name: "read",
        arguments: { file: "```test.ts```" },
      },
      ctx(dir, ["test.ts"])
    );

    expect(r).toContain("const x = 1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("turn loop: null args on optional field are dropped (L0)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-repair-"));

  try {
    await Bun.write(join(dir, "test.ts"), "// content\n");

    // Model sends null for an optional field
    const r = await executeTool(
      {
        name: "read",
        arguments: { file: "test.ts", limit: null },
      },
      ctx(dir, ["test.ts"])
    );

    expect(r).toContain("// content");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("turn loop: edit with stringified array is coerced (L1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-repair-"));

  try {
    await Bun.write(join(dir, "impl.ts"), "const a = 1;\nconst b = 2;\n");

    // Model sends edits as a stringified array instead of an array
    const r = await executeTool(
      {
        name: "edit",
        arguments: {
          file: "impl.ts",
          edits: '[{"oldString":"const a = 1;","newString":"const a = 10;"}]',
        },
      },
      ctx(dir, ["impl.ts"])
    );

    expect(r).toContain("edited impl.ts");

    const content = await Bun.file(join(dir, "impl.ts")).text();

    expect(content).toContain("const a = 10;");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toCreate accepts content aliases (contents/body/text)", () => {
  expect(toCreate({ file: "a.ts", contents: "x\n" })).toEqual({
    file: "a.ts",
    content: "x\n",
  });
  expect(toCreate({ path: "a.ts", body: "y\n" })).toEqual({
    file: "a.ts",
    content: "y\n",
  });
});

test("toEdits accepts snake_case old_string/new_string", () => {
  expect(toEdits({ file: "a.ts", old_string: "a", new_string: "b" })).toEqual({
    file: "a.ts",
    edits: [{ oldString: "a", newString: "b" }],
  });
});

test("diagnoseCreateArgs names keys present and missing content", () => {
  const msg = diagnoseCreateArgs({ file: "src/a.ts" });

  expect(msg).toContain("have {file}");
  expect(msg).toContain("content");
  expect(msg).not.toContain("need file, content)"); // not the opaque one-liner alone
});

test("diagnoseEditArgs names keys when oldString missing", () => {
  const msg = diagnoseEditArgs({ file: "src/a.ts", newString: "y" });

  expect(msg).toContain("have {file, newString}");
  expect(msg).toContain("oldString");
});

test("turn loop: nested arguments create is repaired and writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-repair-"));

  try {
    const r = await executeTool(
      {
        name: "create",
        arguments: {
          arguments: { file: "nested.ts", content: "export const n = 1;\n" },
        },
      },
      ctx(dir, ["**/*"])
    );

    expect(r).toContain("created nested.ts");
    expect(await Bun.file(join(dir, "nested.ts")).text()).toContain(
      "export const n = 1"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("turn loop: create with only file gets field-level diagnose (not history-meta)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-repair-"));
  const reports: string[] = [];

  try {
    const r = await executeTool(
      { name: "create", arguments: { file: "solo.ts" } },
      {
        ...ctx(dir, ["**/*"]),
        report: (e) => {
          reports.push(e.message);
        },
      }
    );

    expect(r).toContain("have {file}");
    expect(r).toContain("need content");
    expect(reports.some((m) => m.includes("create:L3-re-ask"))).toBe(true);
    expect(reports.some((m) => m.includes("create:history-meta"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
