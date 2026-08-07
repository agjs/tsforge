/**
 * Shares reported by a remote server, forced into range.
 *
 * `parseUsage` takes a server's `usage` block at face value — any JSON number
 * is accepted — so a backend with bad arithmetic can report more cached tokens
 * than prompt tokens, or a negative count. Both the per-call log line and the
 * run-level metric derive a share from those numbers, and they must agree:
 * without one shared clamp, a single bad server prints "500%" in the log while
 * the aggregate quietly caps at 1, and the log is exactly where someone would
 * go to check the aggregate.
 *
 * Lives in `lib/` rather than beside either caller because `loop` must not
 * depend on `eval` — eval is the analysis layer over loop's events, not the
 * other way round.
 */
export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}
