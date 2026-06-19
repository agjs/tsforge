import type { ILoopEvent } from "../loop/loop.types";
import { analyzeEvents } from "./metrics";

/** Run identity from the `start` event (a `--log` is self-describing). */
function runMeta(events: readonly ILoopEvent[]): {
  model: string;
  contextWindow: number;
} {
  const start = events.find((e) => e.kind === "start");

  return {
    model: start?.model ?? "?",
    contextWindow: start?.contextWindow ?? 0,
  };
}

/** A compact "n high, 1 critical" summary of denials by risk (empty → ""). */
function denialBreakdown(denialsByRisk: Record<string, number>): string {
  return Object.entries(denialsByRisk)
    .map(([risk, n]) => `${n} ${risk}`)
    .join(", ");
}

/**
 * Render a `--log` event stream as a human-readable run summary — the
 * deterministic counterpart to Codebuff's LLM trace-analyzer. Reuses
 * `analyzeEvents` (no model call), and surfaces policy decisions, which the eval
 * parser used to drop. Feed it `parseEventLog(<log text>)`.
 */
export function formatTrace(events: readonly ILoopEvent[]): string {
  const m = analyzeEvents(events);
  const { model, contextWindow } = runMeta(events);
  const pct =
    contextWindow > 0 ? Math.round((m.peakContext / contextWindow) * 100) : 0;
  const denials = denialBreakdown(m.denialsByRisk);
  const rows: [string, string][] = [
    ["model", model],
    ["final status", m.finalStatus],
    ["failure class", m.failureClass],
    ["turns", String(m.turns)],
    ["turns to green", m.turnsToGreen === null ? "—" : String(m.turnsToGreen)],
    ["model calls", String(m.modelCalls)],
    ["tokens out", String(m.tokensOut)],
    [
      "peak context",
      contextWindow > 0
        ? `${m.peakContext} (${pct}% of ${contextWindow})`
        : String(m.peakContext),
    ],
    ["edits/creates", `${m.edits} (${m.filesCreated} created)`],
    ["gate runs", String(m.gateRuns)],
    [
      "policy denials",
      denials.length > 0
        ? `${m.policyDenies} (${denials})`
        : String(m.policyDenies),
    ],
    ["policy asks", String(m.policyAsks)],
    ["wall clock", `${m.wallClockSeconds}s`],
  ];

  return rows
    .map(([label, value]) => `${label.padEnd(18)} ${value}`)
    .join("\n");
}
