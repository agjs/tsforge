import { test, expect, describe } from "bun:test";
import { toWire } from "../src/inference/wire";
import {
  HARNESS_ARGS_OMITTED,
  projectWriteArgsForWire,
} from "../src/loop/context-hygiene";
import {
  HISTORY_META_PARK_AT,
  HISTORY_META_RESTEER_AT,
  isHistoryMetaOnlyWriteTurn,
  isMalformedWriteRejectContent,
  nextHistoryMetaStreak,
  streakAfterHistoryMetaResteer,
  turnHadHistoryMetaReject,
} from "../src/loop/history-meta-spin";
import { doCreate, doEdit } from "../src/loop/tools/file-ops";
import type { IToolContext } from "../src/loop/tools/tool-context";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards";

describe("projectWriteArgsForWire", () => {
  test("strips stub to empty object — no file, no omit flag", () => {
    const projected = projectWriteArgsForWire("create", {
      file: "a.ts",
      [HARNESS_ARGS_OMITTED]: true,
    });

    expect(projected).toEqual({});
  });

  test("leaves real create args untouched", () => {
    const args = { file: "a.ts", content: "export {}\n" };

    expect(projectWriteArgsForWire("create", args)).toEqual(args);
  });
});

describe("toWire scrub", () => {
  test("does not send omit flag or stub file on the wire", () => {
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

    expect(isRecord(first)).toBe(true);

    if (!isRecord(first)) {
      return;
    }

    const fn = first.function;

    expect(isRecord(fn)).toBe(true);

    if (!isRecord(fn)) {
      return;
    }

    const raw = fn.arguments;

    expect(typeof raw).toBe("string");

    if (typeof raw !== "string") {
      return;
    }

    expect(raw).not.toContain("_harnessArgsOmitted");
    expect(raw).not.toContain("src/cli.ts");
    expect(JSON.parse(raw)).toEqual({});
  });
});

describe("omit-flag vs file-only rejects", () => {
  test("omit-flag create is history-meta", async () => {
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
      const msg = await doCreate(
        { file: "solo.ts", [HARNESS_ARGS_OMITTED]: true },
        ctx
      );

      expect(msg).toContain("history stub");
      expect(reports.some((m) => m.includes("create:history-meta"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("file-only create is L3 diagnose, not history-meta", async () => {
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

      expect(msg).toContain("have {file}");
      expect(msg).toContain("need content");
      expect(reports.some((m) => m.includes("create:L3-re-ask"))).toBe(true);
      expect(reports.some((m) => m.includes("create:history-meta"))).toBe(
        false
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("omit-flag edit is history-meta", async () => {
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
      const msg = await doEdit(
        { file: "a.ts", [HARNESS_ARGS_OMITTED]: true },
        ctx
      );

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

  test("resteer once then park on dry malformed streak", () => {
    expect(HISTORY_META_RESTEER_AT).toBe(3);
    expect(HISTORY_META_PARK_AT).toBe(12);
    expect(streakAfterHistoryMetaResteer()).toBe(HISTORY_META_RESTEER_AT + 1);
  });

  test("L3 malformed args count as bad-write rejects", () => {
    expect(
      isMalformedWriteRejectContent(
        "edit: malformed args — have {(none)}; need file + oldString/newString"
      )
    ).toBe(true);
    expect(
      isMalformedWriteRejectContent(
        "create/edit REJECTED: those args are a harness history stub"
      )
    ).toBe(true);
    expect(isMalformedWriteRejectContent("edit applied ok")).toBe(false);
  });

  test("turnHadHistoryMetaReject sees L3 tool results", () => {
    const messages = [
      {
        role: "tool" as const,
        content:
          "edit: malformed args — have {}; need file + oldString/newString (or edits[]).",
        toolCallId: "1",
      },
    ];

    expect(turnHadHistoryMetaReject(messages, 0)).toBe(true);
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
