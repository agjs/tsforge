/**
 * Shares reported by a remote server, forced into range.
 *
 * `parseUsage` takes a server's `usage` block at face value — any JSON number is
 * accepted — so a backend with bad arithmetic can report more cached tokens than
 * prompt tokens, or a negative count. Both the per-call log line and the
 * run-level metric derive a share from those numbers, and they must agree:
 * without one shared clamp, a single bad server prints "500%" in the log while
 * the aggregate quietly caps at 1, and the log is exactly where someone would go
 * to check the aggregate.
 *
 * DIRECTION MATTERS MORE THAN RANGE. In this codebase a cache share of 0 is a
 * signal with a meaning — the prompt prefix went cold, which for a local vLLM
 * means the harness mutated its own prefix mid-run. So an over-report must
 * saturate UP, never fold down to 0: `Math.min`/`Math.max` already carry
 * `Infinity` to 1 and `-Infinity` to 0, which is the right direction on both
 * ends. An earlier version special-cased every non-finite value to 0 and turned
 * the strongest possible over-report into the strongest under-report —
 * reachable, since `JSON.parse("1e999")` yields `Infinity`.
 *
 * NaN is the one input with no defensible position on the scale (it arises from
 * `0/0` or `Infinity/Infinity`), so it is reported as unmeasurable rather than
 * mapped to either end.
 *
 * Lives in `lib/` rather than beside either caller because `loop` must not
 * depend on `eval` — eval is the analysis layer over loop's events, not the
 * other way round.
 */
export function clampRatio(value: number): number | null {
  if (Number.isNaN(value)) {
    return null;
  }

  return Math.min(1, Math.max(0, value));
}
