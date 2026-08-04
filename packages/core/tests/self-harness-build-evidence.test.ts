import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEvidenceFrom,
  parseEventLog,
  runPassed,
  mineWeaknesses,
} from "../src/self-harness";

/**
 * Real build logs as mining evidence. The corpus stays the measuring
 * instrument — a one-off build cannot show a delta — but a corpus the model
 * passes 8/8 has nothing left to teach it, while its everyday work is full of
 * failures worth mining.
 */

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

describe("parseEventLog", () => {
  test("reads the flat writer's events", () => {
    const events = parseEventLog(
      line({ kind: "cycle", task: "t", message: "turn 1" }) +
        line({ kind: "done", task: "t", message: "done in 1" })
    );

    expect(events.map((e) => e.kind)).toEqual(["cycle", "done"]);
  });

  test("reads the typed ledger's nested shape too", () => {
    // The ledger writes {type, payload:{…}}. Reading only the flat shape mined
    // NOTHING from half the logs on disk — 27 runs became 39 once this landed.
    const events = parseEventLog(
      line({ type: "cycle", payload: { task: "t", message: "turn 1" } }) +
        line({ type: "stuck", payload: { task: "t", message: "parked" } })
    );

    expect(events.map((e) => e.kind)).toEqual(["cycle", "stuck"]);
    expect(events[1]?.message).toBe("parked");
  });

  test("carries the fields classification reads", () => {
    const events = parseEventLog(
      line({
        kind: "validated",
        task: "t",
        message: "gate red",
        passed: false,
        rules: ["TS2307", "no-explicit-any"],
      })
    );

    expect(events[0]?.passed).toBe(false);
    expect(events[0]?.rules).toEqual(["TS2307", "no-explicit-any"]);
  });

  test("survives a truncated log", () => {
    // A crash mid-write is exactly the run worth mining; a parse error must not
    // discard the events that did land.
    const events = parseEventLog(
      line({ kind: "cycle", task: "t", message: "turn 1" }) +
        '{"kind":"done","task":"t","mess'
    );

    expect(events).toHaveLength(1);
  });

  test("drops noise rather than inventing events", () => {
    const events = parseEventLog(
      line({ kind: "token", task: "t", message: "…" }) +
        line({ nokind: true }) +
        "not json at all\n"
    );

    expect(events).toHaveLength(0);
  });
});

describe("runPassed", () => {
  test("the LAST terminal event decides", () => {
    // A multi-task build emits `done` per task. Counting them would call a run
    // green that finished task 1 and then got stuck on task 2 — the run most
    // worth mining.
    const events = parseEventLog(
      line({ kind: "done", task: "1", message: "task 1 done" }) +
        line({ kind: "stuck", task: "2", message: "parked" })
    );

    expect(runPassed(events)).toBe(false);
  });

  test("green when the run ends done", () => {
    const events = parseEventLog(
      line({ kind: "stuck", task: "1", message: "retrying" }) +
        line({ kind: "done", task: "1", message: "done" })
    );

    expect(runPassed(events)).toBe(true);
  });

  test("a run that never terminated is not a pass", () => {
    const events = parseEventLog(
      line({ kind: "cycle", task: "t", message: "" })
    );

    expect(runPassed(events)).toBe(false);
  });
});

describe("buildEvidenceFrom", () => {
  async function logsDir(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-buildlogs-"));

    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), body);
    }

    return dir;
  }

  test("reads each log as one run, newest first", async () => {
    const dir = await logsDir({
      "2026-01-01-a.jsonl":
        line({ kind: "cycle", task: "t", message: "" }) +
        line({ kind: "done", task: "t", message: "" }),
      "2026-02-01-b.jsonl":
        line({ kind: "cycle", task: "t", message: "" }) +
        line({ kind: "stuck", task: "t", message: "" }),
    });

    try {
      const runs = await buildEvidenceFrom(dir);

      expect(runs.map((r) => r.taskId)).toEqual([
        "2026-02-01-b",
        "2026-01-01-a",
      ]);
      expect(runs[0]?.passed).toBe(false);
      expect(runs[1]?.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips a log with no model turns", async () => {
    // An endpoint that was down produces a log with a start line and nothing
    // else. Mining it would manufacture a failure pattern out of an outage —
    // precisely what the campaign's infra guards exist to prevent.
    const dir = await logsDir({
      "2026-01-01-dead.jsonl": line({
        kind: "start",
        task: "t",
        message: "model x",
      }),
    });

    try {
      expect(await buildEvidenceFrom(dir)).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("honours the newest-N limit", async () => {
    const body =
      line({ kind: "cycle", task: "t", message: "" }) +
      line({ kind: "done", task: "t", message: "" });
    const dir = await logsDir({
      "2026-01-01-a.jsonl": body,
      "2026-02-01-b.jsonl": body,
      "2026-03-01-c.jsonl": body,
    });

    try {
      const runs = await buildEvidenceFrom(dir, { limit: 2 });

      expect(runs.map((r) => r.taskId)).toEqual([
        "2026-03-01-c",
        "2026-02-01-b",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing directory is empty evidence, not a crash", async () => {
    // The campaign passes --build-logs unconditionally; a machine with no logs
    // yet must run a corpus-only session rather than abort.
    expect(await buildEvidenceFrom("/nonexistent/logs")).toEqual([]);
  });

  test("the runs it produces actually mine into patterns", async () => {
    // End to end: the shape this module emits is the shape mineWeaknesses eats.
    const dir = await logsDir({
      "2026-01-01-x.jsonl":
        line({ kind: "cycle", task: "t", message: "turn 1" }) +
        line({ kind: "tool", task: "t", message: "edit rejected: no match" }) +
        line({ kind: "tool", task: "t", message: "edit rejected: no match" }) +
        line({
          kind: "validated",
          task: "t",
          message: "gate red",
          passed: false,
          rules: ["TS2307"],
        }) +
        line({ kind: "stuck", task: "t", message: "parked" }),
    });

    try {
      const bundle = mineWeaknesses(await buildEvidenceFrom(dir));

      expect(bundle.failedRuns).toBe(1);
      expect(bundle.patterns.length).toBeGreaterThan(0);
      expect(bundle.patterns[0]?.taskIds).toContain("2026-01-01-x");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
