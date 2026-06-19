import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILoopEvent } from "../src/loop/loop.types";
import { LedgerWriter, ledgerTypeFor } from "../src/loop";
import { parseEventLog, analyzeEvents, formatTrace } from "../src/eval";

/** Mirror cli.ts makeReporter: the only thing that writes a `--log` file is the
 *  LedgerWriter, with payload = the full event. */
function writeLedger(file: string, events: readonly ILoopEvent[]): void {
  const ledger = new LedgerWriter(file, "run-1");

  for (const event of events) {
    ledger.record(ledgerTypeFor(event), { ...event });
  }
}

describe("trace parser: writer↔reader contract", () => {
  // THE BUG: `--log` writes nested ledger lines ({type, payload:{kind,…}}) but the
  // parser read top-level `record.kind`, so parseEventLog on a real log yielded an
  // EMPTY stream — the analyzer silently saw nothing. This locks the round-trip.
  test("parseEventLog reads a real LedgerWriter-produced --log file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-trace-"));

    try {
      const file = join(dir, "run.jsonl");
      const events: ILoopEvent[] = [
        {
          kind: "start",
          task: "t",
          message: "",
          model: "qwen",
          contextWindow: 8000,
        },
        { kind: "cycle", task: "t", message: "", cycle: 1 },
        {
          kind: "usage",
          task: "t",
          message: "",
          promptTokens: 500,
          completionTokens: 120,
          tokensPerSecond: 40,
        },
        { kind: "done", task: "t", message: "" },
      ];

      writeLedger(file, events);

      const parsed = parseEventLog(await Bun.file(file).text());

      expect(parsed.length).toBe(events.length);
      expect(parsed.map((e) => e.kind)).toEqual([
        "start",
        "cycle",
        "usage",
        "done",
      ]);
      // Numeric fields must survive so analyzeEvents on a log is accurate.
      const usage = parsed.find((e) => e.kind === "usage");

      expect(usage?.completionTokens).toBe(120);
      expect(usage?.promptTokens).toBe(500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("policy events round-trip with decision + risk (were dropped entirely)", () => {
    const events: ILoopEvent[] = [
      {
        kind: "policy",
        task: "t",
        message: "blocked rm -rf /",
        decision: "deny",
        risk: "high",
        rules: ["no-destructive-shell"],
      },
    ];
    // Serialize through the ledger shape, then parse it back.
    const line = JSON.stringify({
      eventId: "e1",
      runId: "run-1",
      timestamp: "2026-06-19T00:00:00.000Z",
      type: ledgerTypeFor(events[0]!),
      payload: { ...events[0] },
    });
    const parsed = parseEventLog(line);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.kind).toBe("policy");
    expect(parsed[0]?.decision).toBe("deny");
    expect(parsed[0]?.risk).toBe("high");
    expect(parsed[0]?.rules).toEqual(["no-destructive-shell"]);
  });

  test("legacy flat-format lines still parse (back-compat)", () => {
    const flat = [
      JSON.stringify({ kind: "cycle", task: "t", message: "" }),
      JSON.stringify({ kind: "done", task: "t", message: "" }),
    ].join("\n");
    const parsed = parseEventLog(flat);

    expect(parsed.map((e) => e.kind)).toEqual(["cycle", "done"]);
  });

  // A flat event can legitimately carry its OWN `payload` field (e.g. tool args).
  // The source-shape check must key on top-level `kind` being absent — not just on
  // a `payload` existing — or the flat event's real fields get discarded.
  test("a flat event with its own `payload` field still reads top-level fields", () => {
    const line = JSON.stringify({
      kind: "run",
      task: "t",
      message: "ran",
      payload: { foo: "bar" },
    });
    const parsed = parseEventLog(line);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.kind).toBe("run");
    expect(parsed[0]?.message).toBe("ran");
  });
});

describe("trace metrics: policy counts", () => {
  test("analyzeEvents counts denies, asks, and denials by risk", () => {
    const events: ILoopEvent[] = [
      {
        kind: "policy",
        task: "t",
        message: "",
        decision: "deny",
        risk: "high",
      },
      {
        kind: "policy",
        task: "t",
        message: "",
        decision: "deny",
        risk: "critical",
      },
      {
        kind: "policy",
        task: "t",
        message: "",
        decision: "ask",
        risk: "medium",
      },
      {
        kind: "policy",
        task: "t",
        message: "",
        decision: "allow",
        risk: "low",
      },
    ];
    const m = analyzeEvents(events);

    expect(m.policyDenies).toBe(2);
    expect(m.policyAsks).toBe(1);
    expect(m.denialsByRisk).toEqual({ high: 1, critical: 1 });
  });
});

describe("trace formatter", () => {
  test("formatTrace renders the headline run signals", () => {
    const events: ILoopEvent[] = [
      {
        kind: "start",
        task: "t",
        message: "",
        model: "qwen",
        contextWindow: 8000,
      },
      { kind: "cycle", task: "t", message: "", cycle: 1 },
      {
        kind: "usage",
        task: "t",
        message: "",
        promptTokens: 500,
        completionTokens: 120,
      },
      {
        kind: "policy",
        task: "t",
        message: "",
        decision: "deny",
        risk: "high",
      },
      { kind: "done", task: "t", message: "" },
    ];
    const out = formatTrace(events);

    expect(out).toContain("qwen");
    expect(out).toContain("turns");
    expect(out).toMatch(/den(y|ied|ials)/i);
    expect(out).toContain("high");
  });
});
