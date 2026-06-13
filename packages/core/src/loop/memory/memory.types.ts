/**
 * tsforge MEMORY — the reflect → distill → consolidate → recall loop.
 *
 * Phase 1 (this module set) is the failure→fix channel: mine a run's event
 * stream for mistakes the model MADE then FIXED, accumulate them in a local
 * ledger with recurrence counts, and project the recurring ones into the
 * `.tsforge/learned-rules.json` TTSR file the harness already loads. Memory
 * accumulates aggressively; recall stays cheap (a learned rule is a dormant
 * trigger — zero prompt cost until the exact mistake recurs).
 */

/** A mistake-then-fix pair mined from one run: the gate rule that was failing,
 *  the file it was fixed in, and the edit that cleared it. */
export interface ICandidateLesson {
  /** The gate rule/code that disappeared after the edit (e.g. "no-explicit-any",
   *  "TS18048"). */
  readonly rule: string;
  /** The file whose edit cleared the failure. */
  readonly file: string;
  /** The offending snippet (the edit's replaced text). */
  readonly before: string;
  /** The fix (the edit's replacement text). */
  readonly after: string;
}

/** One accumulated lesson in the project ledger. Carries provenance so it can
 *  decay: a lesson the model stops re-committing eventually retires. */
export interface ILedgerEntry {
  /** Stable, deterministic rule name (derived from rule + a hash of `before`). */
  readonly name: string;
  /** The gate rule/code this lesson guards against. */
  readonly rule: string;
  /** The TTSR condition (a conservative literal regex source matching `before`). */
  readonly condition: string;
  /** The corrective guidance injected when the pattern recurs (≤300 chars). */
  readonly guidance: string;
  /** Glob(s) the rule applies to (the fixed file's directory family). */
  readonly fileGlobs: readonly string[];
  /** How many distinct sessions have produced this lesson. */
  readonly hits: number;
  /** The most recent session id that produced it. */
  readonly source: string;
  /** ms timestamp of the most recent occurrence (for decay). */
  readonly lastSeen: number;
}

/** The on-disk project ledger (`.tsforge/memory.json`): every candidate ever
 *  seen, with counts. The subset with `hits >= MIN_HITS_TO_ACTIVATE` is
 *  projected into the active `.tsforge/learned-rules.json`. */
export interface IMemoryLedger {
  readonly version: 1;
  readonly entries: readonly ILedgerEntry[];
}

/** Empty ledger for a repo with no memory yet. */
export const EMPTY_LEDGER: IMemoryLedger = { version: 1, entries: [] };

/** A lesson must be seen in at least this many sessions before it becomes an
 *  active learned rule — so a single fluke fix never starts steering future
 *  runs (accumulation ≠ injection). */
export const MIN_HITS_TO_ACTIVATE = 2;

/** A learned rule unseen for longer than this is retired from the active set
 *  (kept in the ledger but no longer projected), so stale lessons don't silt up. */
export const DECAY_MS = 1000 * 60 * 60 * 24 * 45; // 45 days
