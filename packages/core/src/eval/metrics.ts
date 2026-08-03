import type { ILoopEvent } from "../loop/loop.types";
import { classifyRun, type FailureClass } from "./failure-class";

/** Behavioral metrics distilled from a run's event stream — the signals the
 *  local-model literature says predict outcomes (tokens-to-solution, repair
 *  iterations, peak context) rather than vibes. A reusable, pure counterpart to
 *  the cli-metrics script. */
export interface IRunMetrics {
  finalStatus: "done" | "stuck" | "none";
  /** Structured reason the run failed (`none` when it reached green). The single
   *  source of truth for failure classification — the cli-metrics analyzer and
   *  the eval sweep both read this rather than re-deriving it. */
  failureClass: FailureClass;
  /** Model turns (one per `cycle` event). */
  turns: number;
  /** Model calls (one per `usage` event). */
  modelCalls: number;
  /** Total completion tokens generated. */
  tokensOut: number;
  /** Total PROMPT tokens sent. Summed, unlike `peakContext` which is the high-water
   *  mark: a variant that enlarges the prompt or the tool context pays for it on
   *  every call, and comparing on output tokens alone reported it as free. */
  tokensIn: number;
  /** Largest prompt-token count seen (the run's context high-water mark). */
  peakContext: number;
  /** File mutations (`edit` + `create`). */
  edits: number;
  /** Edit batches rolled back (`reverted` events) — gate-break or no quality gain.
   *  Spent but never accepted; the numerator of wasted edit effort. */
  editsReverted: number;
  /** Share of mutations that stuck: (edits − editsReverted) / edits, in [0,1];
   *  0 when there were no edits. The article's hidden trap — tokens mean nothing
   *  if most edits get reverted. */
  acceptRate: number;
  /** Total completion tokens per edit that STAYED (tokensOut / net-accepted);
   *  0 when nothing was accepted. Cost of one durable change, not one attempt. */
  costPerAcceptedChange: number;
  /** Distinct files created. */
  filesCreated: number;
  /** Gate runs (`validated` events). */
  gateRuns: number;
  /** Turns taken to reach the FIRST green (at the `done` event), or null if the
   *  run never went green. The headline loop-efficiency signal — lower is better. */
  turnsToGreen: number | null;
  /** Summed turn wall-clock from `timing` events, in seconds. */
  wallClockSeconds: number;
  /** Mean output rate across calls that reported one (tokens/second). */
  avgTokensPerSecond: number;
  /** Policy verdicts that DENIED a proposed action (the safety tripwire count). */
  policyDenies: number;
  /** Policy verdicts that asked for confirmation (resolve-to-deny in headless). */
  policyAsks: number;
  /** Denials bucketed by risk (e.g. {"high":1,"critical":1}); empty when none —
   *  so a run shows not just how often the policy fired but how dangerous it was. */
  denialsByRisk: Record<string, number>;
}

function emptyMetrics(): IRunMetrics {
  return {
    finalStatus: "none",
    failureClass: "none",
    turns: 0,
    modelCalls: 0,
    tokensOut: 0,
    tokensIn: 0,
    peakContext: 0,
    edits: 0,
    editsReverted: 0,
    acceptRate: 0,
    costPerAcceptedChange: 0,
    filesCreated: 0,
    gateRuns: 0,
    turnsToGreen: null,
    wallClockSeconds: 0,
    avgTokensPerSecond: 0,
    policyDenies: 0,
    policyAsks: 0,
    denialsByRisk: {},
  };
}

/** Tally one policy verdict into the metrics (deny → bucketed by risk; ask → its
 *  own counter). Allows are not counted — only the tripwires matter for a run. */
function countPolicy(m: IRunMetrics, event: ILoopEvent): void {
  if (event.decision === "deny") {
    m.policyDenies += 1;

    const risk = event.risk ?? "low";

    m.denialsByRisk[risk] = (m.denialsByRisk[risk] ?? 0) + 1;
  } else if (event.decision === "ask") {
    m.policyAsks += 1;
  }
}

/** Running sums that don't live on IRunMetrics until the end (averages and a
 *  once-rounded wall clock), threaded through the per-event tally. */
interface IAccum {
  tpsSum: number;
  tpsCount: number;
  wallMs: number;
  created: Set<string>;
}

/** Fold one `usage` event in (split out so the per-event tally stays flat). */
function tallyUsage(m: IRunMetrics, event: ILoopEvent, acc: IAccum): void {
  m.modelCalls += 1;
  m.tokensOut += event.completionTokens ?? 0;
  m.tokensIn += event.promptTokens ?? 0;
  m.peakContext = Math.max(m.peakContext, event.promptTokens ?? 0);

  if (event.tokensPerSecond !== undefined && event.tokensPerSecond > 0) {
    acc.tpsSum += event.tokensPerSecond;
    acc.tpsCount += 1;
  }
}

/** Fold one event into the running metrics. A switch (not an else-if chain) so
 *  adding a kind doesn't compound the function's cognitive complexity. */
function tallyEvent(m: IRunMetrics, event: ILoopEvent, acc: IAccum): void {
  switch (event.kind) {
    case "cycle":
      m.turns += 1;
      break;
    case "usage":
      tallyUsage(m, event, acc);
      break;
    case "create":
      m.edits += 1;

      if (event.file !== undefined && event.file.length > 0) {
        acc.created.add(event.file);
      }

      break;
    case "edit":
      m.edits += 1;
      break;
    case "reverted":
      // A reverted batch may have rolled back several mutations; subtract them
      // all (default 1 for an older/countless event) so accept-rate isn't
      // optimistic on multi-file repairs.
      m.editsReverted += event.count ?? 1;
      break;
    case "timing":
      acc.wallMs += event.ms ?? 0;
      break;
    case "validated":
      m.gateRuns += 1;
      break;
    case "done":
      m.finalStatus = "done";
      m.turnsToGreen ??= m.turns;
      break;
    case "stuck":
      m.finalStatus = "stuck";
      break;
    case "policy":
      countPolicy(m, event);
      break;
    default:
      break;
  }
}

/** Reduce a run's event stream to its behavioral metrics. Pure — feed it the
 *  events from a `--log` JSONL or a captured `onEvent` stream. */
export function analyzeEvents(events: readonly ILoopEvent[]): IRunMetrics {
  const m = emptyMetrics();
  // Accumulate raw ms and round ONCE at the end: rounding each timing event
  // would floor sub-second turns to 0s (400+400+400ms → 0s instead of 1s).
  const acc: IAccum = { tpsSum: 0, tpsCount: 0, wallMs: 0, created: new Set() };

  for (const event of events) {
    tallyEvent(m, event, acc);
  }

  m.filesCreated = acc.created.size;

  const netAccepted = Math.max(0, m.edits - m.editsReverted);

  m.acceptRate = m.edits > 0 ? netAccepted / m.edits : 0;
  m.costPerAcceptedChange =
    netAccepted > 0 ? Math.round(m.tokensOut / netAccepted) : 0;
  m.avgTokensPerSecond =
    acc.tpsCount > 0 ? Math.round(acc.tpsSum / acc.tpsCount) : 0;
  m.wallClockSeconds = Math.round(acc.wallMs / 1000);
  m.failureClass = classifyRun(events).failureClass;

  return m;
}
