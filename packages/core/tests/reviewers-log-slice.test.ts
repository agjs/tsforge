import { test, expect, describe } from "bun:test";
import { sliceBuildLog } from "../src/reviewers/log-slice";

function jsonl(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

describe("sliceBuildLog", () => {
  test("keeps everything and reports full when under budget", () => {
    const raw = jsonl([
      { kind: "cycle", message: "turn 1: asking model" },
      { kind: "fix", message: "feature 'X': attempt 1" },
    ]);
    const s = sliceBuildLog(raw, { maxChars: 10_000, tailLines: 10 });

    expect(s.totalLines).toBe(2);
    expect(s.keptLines).toBe(2);
    expect(s.droppedLines).toBe(0);
    expect(s.note).toContain("all kept");
  });

  test("never silently truncates: dropped lines are counted and noted", () => {
    // 100 low-signal cycle events + one park; tiny budget forces drops.
    const events: object[] = [];

    for (let i = 0; i < 100; i += 1) {
      events.push({
        kind: "cycle",
        message: `turn ${String(i)}: asking model`,
      });
    }

    events.push({
      kind: "fix",
      message: "ladder exhausted, parked — revisit later",
    });
    const s = sliceBuildLog(jsonl(events), { maxChars: 200, tailLines: 2 });

    expect(s.totalLines).toBe(101);
    expect(s.droppedLines).toBeGreaterThan(0);
    expect(s.keptLines + s.droppedLines).toBe(s.totalLines);
    expect(s.note).toContain("dropped");
  });

  test("a fix/park line is ALWAYS kept even under a tiny budget", () => {
    const events: object[] = [];

    for (let i = 0; i < 50; i += 1) {
      events.push({
        kind: "run",
        message: `$ some noisy command number ${String(i)}`,
      });
    }

    events.splice(10, 0, {
      kind: "fix",
      message: "ladder exhausted, parked — revisit later",
    });
    const s = sliceBuildLog(jsonl(events), { maxChars: 120, tailLines: 1 });

    expect(s.text).toContain("parked");
  });

  test("error/gate signal lines are kept regardless of position", () => {
    const events: object[] = [
      { kind: "message", message: "no-unsafe-member-access on body.id" },
    ];

    for (let i = 0; i < 40; i += 1) {
      events.push({ kind: "policy", message: "read_file read: mode:default" });
    }

    const s = sliceBuildLog(jsonl(events), { maxChars: 150, tailLines: 1 });

    expect(s.text).toContain("no-unsafe-member-access");
  });

  test("plain (non-JSON) log lines are handled, signal detected", () => {
    const raw = ["starting build", "ERROR: prettier failed", "done"].join("\n");
    const s = sliceBuildLog(raw, { maxChars: 10_000, tailLines: 10 });

    expect(s.totalLines).toBe(3);
    expect(s.text).toContain("prettier failed");
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
