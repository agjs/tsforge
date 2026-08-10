/**
 * Live gate identity for the model: what ran + which packs — without dumping
 * the auto-gate shell pipeline (env vars, absolute tsc paths, eslint JSON flags).
 */

import { GATE_TYPECHECK_IDENTITY } from "../gate/tsconfig";

/** Stable, sorted copy for pack-set comparison / display. */
export function sortedPacks(packs: readonly string[]): string[] {
  return [...packs].sort();
}

/** Packs in `next` that were not in `prev` (order of `next`). */
export function newlyActivatedPacks(
  prev: readonly string[],
  next: readonly string[]
): string[] {
  const before = new Set(prev);

  return next.filter((p) => !before.has(p));
}

/** True when the pack set grew (monotonic activation). */
export function packsGrew(
  prev: readonly string[] | null,
  next: readonly string[]
): boolean {
  if (prev === null) {
    return false;
  }

  return newlyActivatedPacks(prev, next).length > 0;
}

/** Cap for showing a raw accept command verbatim (human / short scripts). */
const SHORT_COMMAND_CHARS = 96;

/**
 * Human-readable gate label for UI + model feedback.
 * Auto-gate commands are env-prefixed shell pipelines hundreds of chars long —
 * never paste those into Check: / task_complete / settle feedback.
 */
export function summarizeGateCommand(command: string): string {
  const trimmed = command.trim();

  if (trimmed.length === 0) {
    return "(none)";
  }

  const isAutoShell =
    trimmed.includes("TSFORGE_PACKS=") ||
    trimmed.includes("TSFORGE_RULE_OVERRIDES=") ||
    trimmed.includes("tsconfig.gate.json") ||
    trimmed.includes("@typescript/native") ||
    trimmed.includes("packages/core/node_modules") ||
    trimmed.length > SHORT_COMMAND_CHARS;

  if (!isAutoShell) {
    return trimmed;
  }

  const stages: string[] = [];

  if (/\btsc\b/i.test(trimmed) || trimmed.includes("tsconfig.gate")) {
    stages.push("tsc");
  }

  if (/\beslint\b/i.test(trimmed)) {
    stages.push("eslint");
  }

  if (/\bbun\s+test\b/i.test(trimmed) || /\bvitest\b/i.test(trimmed)) {
    stages.push("tests");
  }

  if (stages.length === 0) {
    return "auto gate";
  }

  return `auto gate (${stages.join(" + ")})`;
}

/** Compact identity for failures and feedback (no shell-env wall). */
export function formatGateIdentity(
  command: string,
  packs: readonly string[]
): string {
  const cmd = summarizeGateCommand(command);
  const packList = packs.length > 0 ? sortedPacks(packs).join(", ") : "(none)";
  const lines = [`Check: ${cmd}`, `Packs: ${packList}`];
  const usesGateTsconfig =
    command.includes("tsconfig.gate") ||
    command.includes("TSFORGE_PACKS=") ||
    cmd.startsWith("auto gate");

  if (usesGateTsconfig) {
    lines.push(GATE_TYPECHECK_IDENTITY);
  }

  return lines.join("\n");
}

/** Harness inject when stack detection activates more packs mid-session. */
export function formatPackActivationNotice(
  packs: readonly string[],
  activated: readonly string[]
): string {
  const all = sortedPacks(packs).join(", ");
  const added = sortedPacks(activated).join(", ");

  return (
    `Detected packs: ${all} (newly activated: ${added}). ` +
    "The task-contract Check: line now matches this live gate."
  );
}
