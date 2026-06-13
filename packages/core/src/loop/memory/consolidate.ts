import { join } from "node:path";
import { rm } from "node:fs/promises";

import { isRecord, isArray } from "../../lib/guards";
import type { ITtsrRule } from "../ttsr";

import {
  EMPTY_LEDGER,
  MIN_HITS_TO_ACTIVATE,
  DECAY_MS,
  type ICandidateLesson,
  type ILedgerEntry,
  type IMemoryLedger,
} from "./memory.types";

const MEMORY_DIR = ".tsforge";
const LEDGER_FILE = "memory.json";
const LEARNED_RULES_FILE = "learned-rules.json";
const MAX_GUIDANCE = 300;

/** Escape a string for use as a literal regex source. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** djb2 hash → base36, for a short stable id from a snippet. */
function shortHash(text: string): string {
  let hash = 5381;

  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }

  return (hash >>> 0).toString(36);
}

/** The single most informative line of a snippet — the condition matches THIS,
 *  not the whole (possibly multi-line) replaced block, so it stays a tight,
 *  meaningful trigger. */
function salientLine(before: string): string {
  const lines = before
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return lines.reduce(
    (best, line) => (line.length > best.length ? line : best),
    ""
  );
}

/** A conservative literal-regex condition source matching the mistake's salient line. */
export function conditionFor(before: string): string {
  return escapeRegex(salientLine(before));
}

/** A deterministic, collision-resistant rule name from the gate rule + the snippet. */
export function ruleName(rule: string, before: string): string {
  const slug = rule.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();

  return `learned-${slug}-${shortHash(salientLine(before))}`;
}

/** TTSR file globs for the fixed file's family (by extension). */
function fileGlobsFor(file: string): string[] {
  if (file.endsWith(".tsx")) {
    return ["**/*.tsx"];
  }

  if (file.endsWith(".ts")) {
    return ["**/*.ts"];
  }

  return ["**/*"];
}

/** The corrective nudge shown when the learned pattern recurs (capped). */
function guidanceFor(rule: string, after: string): string {
  const fix = salientLine(after);
  const base = `This pattern previously failed the gate (${rule}) in this repo. Use the known-good fix instead`;
  const withFix = fix.length > 0 ? `${base}, e.g.: ${fix}` : `${base}.`;

  return withFix.length > MAX_GUIDANCE
    ? `${withFix.slice(0, MAX_GUIDANCE - 1)}…`
    : withFix;
}

function candidateToEntry(
  candidate: ICandidateLesson,
  sessionId: string,
  now: number
): ILedgerEntry {
  return {
    name: ruleName(candidate.rule, candidate.before),
    rule: candidate.rule,
    condition: conditionFor(candidate.before),
    guidance: guidanceFor(candidate.rule, candidate.after),
    fileGlobs: fileGlobsFor(candidate.file),
    hits: 1,
    source: sessionId,
    lastSeen: now,
  };
}

/**
 * Merge a run's candidates into the ledger. `hits` counts DISTINCT SESSIONS, so
 * multiple candidates with the same name from one run bump it by exactly one;
 * a lesson from a NEW session bumps an existing entry. Returns a new ledger.
 */
export function mergeCandidates(
  ledger: IMemoryLedger,
  candidates: readonly ICandidateLesson[],
  sessionId: string,
  now: number
): IMemoryLedger {
  const byName = new Map<string, ILedgerEntry>(
    ledger.entries.map((e) => [e.name, e])
  );
  // Dedupe this session's candidates by name first (one fix seen twice in a run
  // is still one occurrence).
  const seenThisSession = new Set<string>();

  for (const candidate of candidates) {
    const name = ruleName(candidate.rule, candidate.before);

    if (seenThisSession.has(name)) {
      continue;
    }

    seenThisSession.add(name);

    const existing = byName.get(name);

    if (existing === undefined) {
      byName.set(name, candidateToEntry(candidate, sessionId, now));
      continue;
    }

    // A new session re-producing the lesson bumps hits; the same session never does.
    const bump = existing.source === sessionId ? 0 : 1;

    byName.set(name, {
      ...existing,
      hits: existing.hits + bump,
      source: sessionId,
      lastSeen: now,
    });
  }

  return { version: 1, entries: [...byName.values()] };
}

/** Project the ledger to ACTIVE learned TTSR rules: recurring (hits ≥ threshold)
 *  and not decayed (seen within DECAY_MS). Accumulation ≠ injection. */
export function activeRules(ledger: IMemoryLedger, now: number): ITtsrRule[] {
  return ledger.entries
    .filter(
      (e) => e.hits >= MIN_HITS_TO_ACTIVATE && now - e.lastSeen < DECAY_MS
    )
    .map((e) => ({
      name: e.name,
      condition: [e.condition],
      scope: "tool-args" as const,
      // No fileGlobs: the condition is already a specific code snippet, and the
      // TTSR file-glob matcher does not match `**/*.ts`-style patterns — setting
      // one would silently prevent the rule from ever firing.
      guidance: e.guidance,
      repeatMode: "cooldown" as const,
      repeatGap: 3,
    }));
}

/** Parse a stored ledger, tolerating any malformation (→ empty), like the rest
 *  of tsforge's disk readers. */
function parseLedger(content: string): IMemoryLedger {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return EMPTY_LEDGER;
  }

  if (!isRecord(parsed) || !isArray(parsed.entries)) {
    return EMPTY_LEDGER;
  }

  const entries = parsed.entries.filter(
    (e): e is ILedgerEntry =>
      isRecord(e) &&
      typeof e.name === "string" &&
      typeof e.rule === "string" &&
      typeof e.condition === "string" &&
      typeof e.guidance === "string" &&
      isArray(e.fileGlobs) &&
      typeof e.hits === "number" &&
      typeof e.source === "string" &&
      typeof e.lastSeen === "number"
  );

  return { version: 1, entries };
}

/** Forget all learned memory for a project: delete the ledger and the active
 *  learned-rules file (`tsforge memory forget`). Best-effort. */
export async function forgetMemory(cwd: string): Promise<void> {
  for (const name of [LEDGER_FILE, LEARNED_RULES_FILE]) {
    await rm(join(cwd, MEMORY_DIR, name), { force: true });
  }
}

/** Load the project ledger from `<cwd>/.tsforge/memory.json`. */
export async function loadLedger(cwd: string): Promise<IMemoryLedger> {
  const file = Bun.file(join(cwd, MEMORY_DIR, LEDGER_FILE));

  if (!(await file.exists())) {
    return EMPTY_LEDGER;
  }

  return parseLedger(await file.text());
}

/**
 * The full Phase-1 consolidation step: load the ledger, merge this run's
 * candidates, persist the ledger, and (re)write the active learned-rules file
 * the TTSR loader reads. Returns the count of active rules written.
 */
export async function consolidate(
  cwd: string,
  candidates: readonly ICandidateLesson[],
  sessionId: string,
  now: number = Date.now()
): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }

  const merged = mergeCandidates(
    await loadLedger(cwd),
    candidates,
    sessionId,
    now
  );
  const active = activeRules(merged, now);

  await Bun.write(
    join(cwd, MEMORY_DIR, LEDGER_FILE),
    `${JSON.stringify(merged, null, 2)}\n`
  );
  await Bun.write(
    join(cwd, MEMORY_DIR, LEARNED_RULES_FILE),
    `${JSON.stringify(active, null, 2)}\n`
  );

  return active.length;
}
