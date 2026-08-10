import { test, expect, describe } from "bun:test";
import { toWire } from "../src/inference/wire";
import {
  HARNESS_ARGS_OMITTED,
  isIncompleteWriteStub,
  projectWriteArgsForWire,
} from "../src/loop/context-hygiene";
import {
  HISTORY_META_PARK_AT,
  HISTORY_META_RESTEER_AT,
  isHistoryMetaOnlyWriteTurn,
  nextHistoryMetaStreak,
  streakAfterHistoryMetaResteer,
} from "../src/loop/history-meta-spin";
import { doCreate, doEdit } from "../src/loop/tools/file-ops";
import type { IToolContext } from "../src/loop/tools/tool-context";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("projectWriteArgsForWire", () => {
  test("strips omit flag — wire sees file only", () => {
    const projected = projectWriteArgsForWire("create", {
      file: "a.ts",
      [HARNESS_ARGS_OMITTED]: true,
    });

    expect(projected).toEqual({ file: "a.ts" });
    expect(projected).not.toHaveProperty(HARNESS_ARGS_OMITTED);
  });

  test("leaves real create args untouched", () => {
    const args = { file: "a.ts", content: "export {}\n" };

    expect(projectWriteArgsForWire("create", args)).toEqual(args);
  });
});

describe("toWire scrub", () => {
  test("does not send _harnessArgsOmitted on the wire", () => {
    const wire = toWire({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "1",
          name: "create",
          arguments: { file: "src/cli.ts", [HARNESS_ARGS_OMITTED]: true },
        },
      ],
    });
    const calls = wire.tool_calls;

    expect(Array.isArray(calls)).toBe(true);

    if (!Array.isArray(calls)) {
      return;
    }

    const first = calls[0];

    expect(first).toBeDefined();

    if (first === undefined || typeof first !== "object" || first === null) {
      return;
    }

    const fn = "function" in first ? first.function : undefined;

    expect(fn).toBeDefined();

    if (fn === undefined || typeof fn !== "object" || fn === null) {
      return;
    }

    const raw = "arguments" in fn ? fn.arguments : undefined;

    expect(typeof raw).toBe("string");

    if (typeof raw !== "string") {
      return;
    }

    expect(raw).not.toContain("_harnessArgsOmitted");
    expect(JSON.parse(raw)).toEqual({ file: "src/cli.ts" });
  });
});

describe("isIncompleteWriteStub", () => {
  test("file-only is incomplete", () => {
    expect(isIncompleteWriteStub({ file: "a.ts" })).toBe(true);
  });

  test("omit flag is incomplete", () => {
    expect(
      isIncompleteWriteStub({ file: "a.ts", [HARNESS_ARGS_OMITTED]: true })
    ).toBe(true);
  });

  test("real content is complete", () => {
    expect(isIncompleteWriteStub({ file: "a.ts", content: "x" })).toBe(false);
  });
});

describe("file-only create/edit → history-meta", () => {
  test("create with only file is history-meta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-meta-"));
    const reports: string[] = [];
    const ctx: IToolContext = {
      cwd: dir,
      files: ["**/*"],
      task: "t",
      report: (e) => {
        reports.push(e.message);
      },
    };

    try {
      const msg = await doCreate({ file: "solo.ts" }, ctx);

      expect(msg).toContain("history stub");
      expect(reports.some((m) => m.includes("create:history-meta"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("edit with only file is history-meta", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-meta-"));

    await Bun.write(join(dir, "a.ts"), "export const x = 1;\n");
    const reports: string[] = [];
    const ctx: IToolContext = {
      cwd: dir,
      files: ["**/*"],
      task: "t",
      report: (e) => {
        reports.push(e.message);
      },
    };

    try {
      const msg = await doEdit({ file: "a.ts" }, ctx);

      expect(msg).toContain("history stub");
      expect(reports.some((m) => m.includes("edit:history-meta"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("history-meta streak", () => {
  test("bumps on meta, resets on successful write", () => {
    expect(
      nextHistoryMetaStreak({
        previous: 2,
        hadHistoryMeta: true,
        successfulWrite: false,
      })
    ).toBe(3);
    expect(
      nextHistoryMetaStreak({
        previous: 5,
        hadHistoryMeta: true,
        successfulWrite: true,
      })
    ).toBe(0);
    expect(
      nextHistoryMetaStreak({
        previous: 4,
        hadHistoryMeta: false,
        successfulWrite: false,
      })
    ).toBe(4);
  });

  test("resteer / park thresholds", () => {
    expect(HISTORY_META_RESTEER_AT).toBe(3);
    expect(HISTORY_META_PARK_AT).toBe(8);
    expect(streakAfterHistoryMetaResteer()).toBe(3);
  });

  test("history-meta-only write turn detection", () => {
    expect(
      isHistoryMetaOnlyWriteTurn({
        calls: [{ name: "create" }],
        hadHistoryMeta: true,
        successfulWrite: false,
      })
    ).toBe(true);
    expect(
      isHistoryMetaOnlyWriteTurn({
        calls: [{ name: "create" }],
        hadHistoryMeta: true,
        successfulWrite: true,
      })
    ).toBe(false);
    expect(
      isHistoryMetaOnlyWriteTurn({
        calls: [{ name: "read" }],
        hadHistoryMeta: true,
        successfulWrite: false,
      })
    ).toBe(false);
  });
});
