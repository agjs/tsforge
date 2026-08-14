import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doDeleteFile } from "../src/loop/tools/delete-file";
import { executeTool } from "../src/loop/tools/execute-tool";
import type { IToolContext } from "../src/loop/tools/tool-context";
import { TOOL_NAME, TOOL_SPECS } from "../src/agent/agent.constants";
import { classifyAction } from "../src/policy/classify";

function ctx(cwd: string, files: string[] = ["**/*"]): IToolContext {
  return { cwd, files, task: "t", report: () => undefined };
}

/**
 * The shell's `rm` is a critical deny in every policy mode. That is correct for
 * `rm -rf`, but it also blocked removing ONE superseded file: a logged refactor
 * tried `rm src/features/feed/GamerCard.tsx` twice, was denied both times, and
 * left a re-export shim behind as dead code.
 */
describe("delete removes exactly one in-scope file", () => {
  test("deletes a file the model could have edited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-del-"));

    try {
      await writeFile(join(dir, "old.ts"), "export const a = 1;\n");

      const out = await doDeleteFile({ file: "old.ts" }, ctx(dir));

      expect(out).toContain("deleted old.ts");
      expect(await Bun.file(join(dir, "old.ts")).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a file outside the editable scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-del-scope-"));

    try {
      await writeFile(join(dir, "locked.ts"), "export const a = 1;\n");

      const out = await doDeleteFile(
        { file: "locked.ts" },
        ctx(dir, ["src/**"])
      );

      expect(out).toContain("out of scope");
      // The file must SURVIVE — a rejected delete that still deleted would be
      // the worst possible bug in this tool.
      expect(await Bun.file(join(dir, "locked.ts")).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a glob rather than expanding it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-del-glob-"));

    try {
      await writeFile(join(dir, "a.ts"), "1");
      await writeFile(join(dir, "b.ts"), "2");

      const out = await doDeleteFile({ file: "*.ts" }, ctx(dir));

      expect(out).toContain("no globs");
      expect(await Bun.file(join(dir, "a.ts")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "b.ts")).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-del-dir-"));

    try {
      await mkdir(join(dir, "src"));
      await writeFile(join(dir, "src", "keep.ts"), "1");

      const out = await doDeleteFile({ file: "src" }, ctx(dir));

      expect(out).toContain("directory");
      expect(await Bun.file(join(dir, "src", "keep.ts")).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing file is a no-op, not an error to recover from", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-del-missing-"));

    try {
      const out = await doDeleteFile({ file: "gone.ts" }, ctx(dir));

      expect(out).toContain("does not exist");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("delete is gated like the other write tools", () => {
  test("plan mode rejects it even if the call is forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-del-plan-"));

    try {
      await writeFile(join(dir, "keep.ts"), "export const a = 1;\n");

      const out = await executeTool(
        { name: TOOL_NAME.deleteFile, arguments: { file: "keep.ts" } },
        { ...ctx(dir), readOnly: true }
      );

      expect(out).toContain("plan mode");
      expect(await Bun.file(join(dir, "keep.ts")).exists()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("it is a write, and never exposed to the batch `script` tool", () => {
    const cap = TOOL_SPECS[TOOL_NAME.deleteFile];

    expect(cap.readOnly).toBe(false);
    // `script` loops over files; batch deletion is the blast radius this tool
    // exists to avoid.
    expect(cap.scriptExposable).toBe(false);
  });

  test("policy classifies it as delete_file, so a repo can deny it", () => {
    const action = classifyAction(
      { name: TOOL_NAME.deleteFile, arguments: { file: "a.ts" } },
      "/tmp"
    );

    // The ActionKind existed in the taxonomy with no producer until now.
    expect(action.kind).toBe("delete_file");
  });
});
