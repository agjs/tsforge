/**
 * Env-gated frame statistics (`TSFORGE_PERF=1`) — the render pipeline had no
 * instrumentation at all, so every perf claim was a guess. Counters are cheap
 * enough to leave compiled in: the disabled path is a single boolean check.
 * Consumed by scripts/bench-pane.ts and scripts/e2e-perf-pty.py, and printed
 * once to stderr on exit so a real REPL run can be measured from outside.
 */

export interface IPaintStats {
  fullPaints: number;
  mainOnlyPaints: number;
  inputOnlyPaints: number;
  topOnlyPaints: number;
  appendMainCalls: number;
  setAgentTreeCalls: number;
  bytesWritten: number;
  /** Cumulative milliseconds spent inside each paint kind. */
  fullPaintMs: number;
  mainOnlyPaintMs: number;
  inputOnlyPaintMs: number;
  /** Worst observed event-loop stall (drift of a 50ms heartbeat). */
  maxStallMs: number;
}

function emptyStats(): IPaintStats {
  return {
    fullPaints: 0,
    mainOnlyPaints: 0,
    inputOnlyPaints: 0,
    topOnlyPaints: 0,
    appendMainCalls: 0,
    setAgentTreeCalls: 0,
    bytesWritten: 0,
    fullPaintMs: 0,
    mainOnlyPaintMs: 0,
    inputOnlyPaintMs: 0,
    maxStallMs: 0,
  };
}

/** Read once at module load — the probe must cost one boolean when off. */
export const PERF_ENABLED = process.env.TSFORGE_PERF === "1";

const stats = emptyStats();

const STALL_PROBE_MS = 50;
let stallTimer: ReturnType<typeof setInterval> | null = null;

/** Arm the event-loop stall probe (idempotent). unref'd — never keeps the
 *  process alive. Only meaningful when PERF_ENABLED; callers guard. */
export function armStallProbe(): void {
  if (!PERF_ENABLED || stallTimer !== null) {
    return;
  }

  let last = performance.now();

  stallTimer = setInterval(() => {
    const now = performance.now();
    const drift = now - last - STALL_PROBE_MS;

    if (drift > stats.maxStallMs) {
      stats.maxStallMs = drift;
    }

    last = now;
  }, STALL_PROBE_MS);
  stallTimer.unref();
}

export function countPaint(
  kind: "full" | "mainOnly" | "inputOnly" | "topOnly",
  ms: number
): void {
  if (kind === "full") {
    stats.fullPaints += 1;
    stats.fullPaintMs += ms;
  } else if (kind === "mainOnly") {
    stats.mainOnlyPaints += 1;
    stats.mainOnlyPaintMs += ms;
  } else if (kind === "inputOnly") {
    stats.inputOnlyPaints += 1;
    stats.inputOnlyPaintMs += ms;
  } else {
    stats.topOnlyPaints += 1;
  }
}

export function countAppendMain(): void {
  stats.appendMainCalls += 1;
}

export function countSetAgentTree(): void {
  stats.setAgentTreeCalls += 1;
}

export function countBytes(n: number): void {
  stats.bytesWritten += n;
}

/** Snapshot for tests/benches. */
export function paintStats(): Readonly<IPaintStats> {
  return { ...stats };
}

/** Reset between bench scenarios / tests. */
export function resetPaintStats(): void {
  Object.assign(stats, emptyStats());
}

/** One machine-parseable summary line (scraped by the perf PTY e2e). */
export function formatPerfSummary(): string {
  return `perf_summary ${JSON.stringify(stats)}`;
}

/** Print the summary to stderr — bypasses the pane so it survives EXIT_ALT. */
export function emitPerfSummary(): void {
  if (!PERF_ENABLED) {
    return;
  }

  process.stderr.write(`${formatPerfSummary()}\n`);
}
