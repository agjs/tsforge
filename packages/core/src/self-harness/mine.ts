/**
 * Weakness Mining (paper §3.2): turn held-in, verifier-grounded FAILURES into
 * clustered failure patterns. Deterministic — no model call. Each failed run
 * gets a signature φ = (verifier cause, dominant agent-side signal, dominant
 * rule code); exact agreement on φ clusters runs, so two failures group only
 * when they plausibly admit the SAME harness-level intervention.
 */
import { classifyRun } from "../eval/failure-class";
import type { IFailureSignals } from "../eval/failure-class";
import type { ILoopEvent } from "../loop/loop.types";
import type { IEvidenceBundle, IFailurePattern } from "./self-harness.types";

/** One evaluated run, as mine consumes it. */
export interface IMinedRun {
  readonly taskId: string;
  readonly passed: boolean;
  readonly events: readonly ILoopEvent[];
  /** When set, a PASSED run with at least this many cycles is still mined —
   *  as a `slow-green` pattern (efficiency signal). The threshold travels with
   *  the run so the evaluator can scale it per task kind (spec vs web build);
   *  absent = green runs are never mined. */
  readonly slowThreshold?: number;
}

/** Model turns a run consumed (one `cycle` event per loop iteration). */
export function cycleCount(events: readonly ILoopEvent[]): number {
  return events.filter((e) => e.kind === "cycle").length;
}

/** Precedence-ordered detection of the dominant AGENT-side behavior in a
 *  failed run. Terminal booleans first (they end the run outright), then the
 *  largest behavioral tally. "none" = the failure lives in the final gate
 *  output, not in any recurrent agent behavior. */
export function dominantSignal(signals: IFailureSignals): string {
  if (signals.degenerated) {
    return "degenerated";
  }

  if (signals.timedOut) {
    return "timed-out";
  }

  if (signals.toolUseFailed) {
    return "tool-use-failed";
  }

  const tallies: readonly [string, number][] = [
    ["edit-rejects", signals.editRejects],
    ["tool-salvages", signals.salvages],
    ["repair-loop", signals.repairs >= 3 ? signals.repairs : 0],
  ];
  let best: [string, number] = ["none", 0];

  for (const [name, count] of tallies) {
    if (count > best[1]) {
      best = [name, count];
    }
  }

  return best[0];
}

/** Deterministic one-line description of the agent mechanism behind a
 *  signature — the "inferred agent mechanism" field of the paper's evidence
 *  bundle, phrased so the proposer can target it with a bounded edit. */
const MECHANISMS: Record<string, string> = {
  degenerated:
    "The model degenerated into a repetition loop and the stream guard ended the run.",
  "timed-out":
    "Model calls timed out repeatedly; the run ended before producing a green gate.",
  "tool-use-failed":
    "The model never produced usable tool calls (malformed calls or narrated code instead of creating files).",
  "edit-rejects":
    "The model repeatedly targeted edit snippets/files that don't match the working tree (stale reads or hallucinated targets).",
  "tool-salvages":
    "The model emitted malformed tool calls the parser had to salvage, burning turns on re-asks.",
  "repair-loop":
    "Gate errors persisted across many repair cycles without converging on green.",
  none: "No recurrent agent-side behavior — the failure is characterized by the final gate errors.",
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Short representative event lines: the last failing gate verdict plus the
 *  last couple of tool/repair messages — evidence, not a transcript dump. */
function traceSnippets(events: readonly ILoopEvent[]): string[] {
  const snippets: string[] = [];
  const lastRedGate = [...events]
    .reverse()
    .find((e) => e.kind === "validated" && e.passed === false);

  if (lastRedGate !== undefined) {
    snippets.push(truncate(`gate: ${lastRedGate.message}`, 160));
  }

  const behavioral = events
    .filter(
      (e) =>
        (e.kind === "tool" || e.kind === "repair" || e.kind === "stuck") &&
        e.message.length > 0
    )
    .slice(-2)
    .map((e) => truncate(`${e.kind}: ${e.message}`, 160));

  return [...snippets, ...behavioral];
}

/** The failing rules on the LAST red gate — the verifier evidence backing the
 *  cluster. */
function verifierEvidence(events: readonly ILoopEvent[]): string[] {
  const lastRedGate = [...events]
    .reverse()
    .find((e) => e.kind === "validated" && e.passed === false);

  return [...new Set(lastRedGate?.rules ?? [])];
}

interface IClusterDraft {
  failureClass: string;
  signal: string;
  detail?: string;
  taskIds: string[];
  evidence: Set<string>;
  snippets: string[];
  slowGreen: boolean;
}

/** Cluster failed held-in runs by exact signature agreement and rank by
 *  support (paper: recurring mechanisms first — they most plausibly map to a
 *  high-value harness modification). Ties break lexicographically so the
 *  bundle is fully deterministic. */
export function mineWeaknesses(runs: readonly IMinedRun[]): IEvidenceBundle {
  const clusters = new Map<string, IClusterDraft>();
  let failedRuns = 0;
  let slowGreenRuns = 0;

  for (const run of runs) {
    // A green run is minable ONLY as an efficiency pattern: it must carry a
    // slow-green threshold and have crossed it. Everything else green skips.
    const cycles = run.passed ? cycleCount(run.events) : 0;
    const slowGreen =
      run.passed &&
      run.slowThreshold !== undefined &&
      cycles >= run.slowThreshold;

    if (run.passed && !slowGreen) {
      continue;
    }

    if (slowGreen) {
      slowGreenRuns += 1;
    } else {
      failedRuns += 1;
    }

    // classifyRun tallies behavioral signals BEFORE the green early-return, so
    // a slow-green run still exposes its friction (edit-rejects, salvages,
    // repair churn) — the mechanism the proposer needs to target.
    const summary = classifyRun(run.events);
    const signal = dominantSignal(summary.signals);
    const failureClass = slowGreen ? "slow-green" : summary.failureClass;
    const signature = `${failureClass}|${signal}|${summary.detail ?? "-"}`;
    const existing = clusters.get(signature);
    const snippets = slowGreen
      ? [
          `slow-green: ${run.taskId} reached green in ${String(cycles)} cycles (threshold ${String(run.slowThreshold)})`,
          ...traceSnippets(run.events).slice(0, 2),
        ]
      : traceSnippets(run.events);

    if (existing === undefined) {
      clusters.set(signature, {
        failureClass,
        signal,
        ...(summary.detail === undefined ? {} : { detail: summary.detail }),
        taskIds: [run.taskId],
        evidence: new Set(verifierEvidence(run.events)),
        snippets,
        slowGreen,
      });
    } else {
      existing.taskIds.push(run.taskId);

      for (const rule of verifierEvidence(run.events)) {
        existing.evidence.add(rule);
      }

      // Keep the bundle bounded: at most 4 snippets per cluster.
      existing.snippets.push(
        ...snippets.slice(0, 4 - existing.snippets.length)
      );
    }
  }

  const patterns: IFailurePattern[] = [...clusters.entries()]
    .map(([signature, draft]) => ({
      signature,
      failureClass: draft.failureClass,
      dominantSignal: draft.signal,
      ...(draft.detail === undefined ? {} : { detail: draft.detail }),
      support: draft.taskIds.length,
      taskIds: draft.taskIds,
      verifierEvidence: [...draft.evidence].sort((a, b) => a.localeCompare(b)),
      traceSnippets: draft.snippets,
      mechanism: draft.slowGreen
        ? `Reaches green but burns an outsized cycle budget — recurring friction: ${MECHANISMS[draft.signal] ?? MECHANISMS.none ?? ""}`
        : (MECHANISMS[draft.signal] ?? MECHANISMS.none ?? ""),
    }))
    .sort((a, b) =>
      a.support === b.support
        ? a.signature.localeCompare(b.signature)
        : b.support - a.support
    );

  return { totalRuns: runs.length, failedRuns, slowGreenRuns, patterns };
}
