import { test, expect, describe } from "bun:test";
import { sliceBuildLog } from "../src/reviewers/log-slice";

function jsonl(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

describe("sliceBuildLog", () => {
  test("keeps everything and reports full when nothing is dropped", () => {
    const raw = jsonl([
      { kind: "fix", message: "feature 'X': attempt 1" },
      { kind: "fix", message: "feature 'X': ladder exhausted, parked" },
    ]);
    const s = sliceBuildLog(raw, { maxChars: 10_000, tailLines: 10 });

    expect(s.totalLines).toBe(2);
    expect(s.droppedLines).toBe(0);
    expect(s.note).toContain("compacted view of all 2 events");
  });

  test("never silently truncates: text respects the ceiling and drops are noted", () => {
    const events: object[] = [];

    for (let i = 0; i < 100; i += 1) {
      events.push({
        kind: "message",
        message: `distinct gate error number ${String(i)} in some file`,
      });
    }

    const s = sliceBuildLog(jsonl(events), { maxChars: 300, tailLines: 2 });

    expect(s.text.length).toBeLessThanOrEqual(300);
    expect(s.droppedLines).toBeGreaterThan(0);
    expect(s.note).toContain("Dropped");
  });

  test("dedupes identical repeated lines into one with a (×N) marker", () => {
    const events: object[] = [];

    for (let i = 0; i < 21; i += 1) {
      events.push({
        kind: "message",
        message: "phantom rule method-with-this-requires-void fires",
      });
    }

    const s = sliceBuildLog(jsonl(events), { maxChars: 10_000, tailLines: 5 });

    expect(s.text).toContain("(×21)");
    // one unique line, not 21
    expect(s.text.split("\n")).toHaveLength(1);
  });

  test("caps a very long single line and marks the truncation", () => {
    const long = "x".repeat(2000);
    const s = sliceBuildLog(
      jsonl([{ kind: "message", message: `error ${long}` }]),
      {
        maxChars: 10_000,
        tailLines: 5,
      }
    );

    expect(s.text.length).toBeLessThan(260);
    expect(s.text).toContain("…");
  });

  test("a fix/park line is kept ahead of bulk context", () => {
    const events: object[] = [];

    for (let i = 0; i < 50; i += 1) {
      events.push({ kind: "run", message: `$ noisy command ${String(i)}` });
    }

    events.splice(10, 0, {
      kind: "fix",
      message: "ladder exhausted, parked — revisit later",
    });

    const s = sliceBuildLog(jsonl(events), { maxChars: 400, tailLines: 1 });

    expect(s.text).toContain("parked");
  });

  test("signal kept; repeated bulk policy noise collapses to one line", () => {
    const events: object[] = [
      { kind: "message", message: "no-unsafe-member-access on body.id" },
    ];

    for (let i = 0; i < 40; i += 1) {
      events.push({ kind: "policy", message: "read_file read: mode:default" });
    }

    const s = sliceBuildLog(jsonl(events), { maxChars: 2000, tailLines: 1 });

    expect(s.text).toContain("no-unsafe-member-access");
    // 41 events compress to two unique lines (signal + the deduped policy noise)
    expect(s.text.split("\n").length).toBeLessThanOrEqual(2);
    expect(s.text).toContain("(×40)");
  });

  test("plain (non-JSON) log lines are handled and signal detected", () => {
    const raw = ["starting build", "ERROR: prettier failed", "done"].join("\n");
    const s = sliceBuildLog(raw, { maxChars: 10_000, tailLines: 10 });

    expect(s.totalLines).toBe(3);
    expect(s.text).toContain("prettier failed");
  });

  test("reads the typed-ledger payload shape (fields under payload)", () => {
    const raw = jsonl([
      {
        type: "log",
        payload: { kind: "fix", message: "ladder exhausted, parked" },
      },
    ]);
    const s = sliceBuildLog(raw, { maxChars: 10_000, tailLines: 5 });

    expect(s.text).toContain("[fix]");
    expect(s.text).toContain("parked");
  });

  test("includes diagnostic output/errors on a FAILED run, not just the command", () => {
    const raw = jsonl([
      {
        kind: "run",
        message: "$ bun run check",
        exitCode: 1,
        output: "src/x.ts:13 error no-invalid-void-type",
      },
    ]);
    const s = sliceBuildLog(raw, { maxChars: 10_000, tailLines: 5 });

    expect(s.text).toContain("no-invalid-void-type");
    expect(s.text).toContain("exit=1");
  });

  test("elides output of a GREEN command (token thrift)", () => {
    const raw = jsonl([
      {
        kind: "run",
        message: "$ find apps -name '*.ts'",
        exitCode: 0,
        output: "apps/a.ts\napps/b.ts\napps/c.ts",
      },
    ]);
    const s = sliceBuildLog(raw, { maxChars: 10_000, tailLines: 5 });

    expect(s.text).not.toContain("apps/a.ts");
  });

  test("annotates non-zero exit codes and file paths", () => {
    const raw = jsonl([
      { kind: "run", message: "$ bun run validate", exitCode: 1 },
      { kind: "edit", message: "edit x", file: "apps/api/src/x.ts" },
    ]);
    const s = sliceBuildLog(raw, { maxChars: 10_000, tailLines: 10 });

    expect(s.text).toContain("exit=1");
    expect(s.text).toContain("apps/api/src/x.ts");
  });
});
