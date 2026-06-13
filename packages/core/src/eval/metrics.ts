import type { ILoopEvent } from "../loop/loop.types";

/** Behavioral metrics distilled from a run's event stream — the signals the
 *  local-model literature says predict outcomes (tokens-to-solution, repair
 *  iterations, peak context) rather than vibes. A reusable, pure counterpart to
 *  the cli-metrics script. */
export interface IRunMetrics {
  finalStatus: "done" | "stuck" | "none";
  /** Model turns (one per `cycle` event). */
  turns: number;
  /** Model calls (one per `usage` event). */
  modelCalls: number;
  /** Total completion tokens generated. */
  tokensOut: number;
  /** Largest prompt-token count seen (the run's context high-water mark). */
  peakContext: number;
  /** File mutations (`edit` + `create`). */
  edits: number;
  /** Distinct files created. */
  filesCreated: number;
  /** Gate runs (`validated` events). */
  gateRuns: number;
  /** Summed turn wall-clock from `timing` events, in seconds. */
  wallClockSeconds: number;
  /** Mean output rate across calls that reported one (tokens/second). */
  avgTokensPerSecond: number;
}

function emptyMetrics(): IRunMetrics {
  return {
    finalStatus: "none",
    turns: 0,
    modelCalls: 0,
    tokensOut: 0,
    peakContext: 0,
    edits: 0,
    filesCreated: 0,
    gateRuns: 0,
    wallClockSeconds: 0,
    avgTokensPerSecond: 0,
  };
}

/** Reduce a run's event stream to its behavioral metrics. Pure — feed it the
 *  events from a `--log` JSONL or a captured `onEvent` stream. */
export function analyzeEvents(events: readonly ILoopEvent[]): IRunMetrics {
  const m = emptyMetrics();
  const created = new Set<string>();
  let tpsSum = 0;
  let tpsCount = 0;

  for (const event of events) {
    if (event.kind === "cycle") {
      m.turns += 1;
    } else if (event.kind === "usage") {
      m.modelCalls += 1;
      m.tokensOut += event.completionTokens ?? 0;
      m.peakContext = Math.max(m.peakContext, event.promptTokens ?? 0);

      if (event.tokensPerSecond !== undefined && event.tokensPerSecond > 0) {
        tpsSum += event.tokensPerSecond;
        tpsCount += 1;
      }
    } else if (event.kind === "create") {
      m.edits += 1;

      if (event.file !== undefined && event.file.length > 0) {
        created.add(event.file);
      }
    } else if (event.kind === "edit") {
      m.edits += 1;
    } else if (event.kind === "timing") {
      m.wallClockSeconds += Math.round((event.ms ?? 0) / 1000);
    } else if (event.kind === "validated") {
      m.gateRuns += 1;
    } else if (event.kind === "done") {
      m.finalStatus = "done";
    } else if (event.kind === "stuck") {
      m.finalStatus = "stuck";
    }
  }

  m.filesCreated = created.size;
  m.avgTokensPerSecond = tpsCount > 0 ? Math.round(tpsSum / tpsCount) : 0;

  return m;
}
