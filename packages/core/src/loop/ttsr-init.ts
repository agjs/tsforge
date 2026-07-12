import { join } from "node:path";

import type { Reporter } from "./loop.types";
import type { ILoopState } from "./turn";
import type { IChatMessage } from "../inference";
import { TtsrManager, parseProjectRules, type ITtsrRule } from "./ttsr";
import { DEFAULT_TTSR_RULES } from "./ttsr-defaults";
import { activeOverlay } from "../self-harness/overlay";

/** Global backstop across ALL rules. Individual noisy rules are silenced
 *  per-rule (TtsrManager.recordInterrupt, cap 2) well before this trips; the
 *  global cap only guards against pathological runs where many DIFFERENT
 *  rules keep interrupting — that signals a model that can't hold the
 *  constraints, and more aborts just burn its generation budget. */
const TTSR_INTERRUPT_CAP = 6;

/**
 * Load a project's TTSR rules: hand-authored `.tsforge/rules.json` AND the
 * memory-learned `.tsforge/learned-rules.json` (the failure→fix lessons the
 * harness wrote itself). Both are tolerated-if-missing. Learned rules are named
 * `learned-*`, so they never collide with hand or built-in rules on dedup.
 */
export async function loadProjectTtsrRules(cwd: string): Promise<ITtsrRule[]> {
  const files = [
    join(cwd, ".tsforge", "rules.json"),
    join(cwd, ".tsforge", "learned-rules.json"),
  ];
  const rules: ITtsrRule[] = [];

  for (const path of files) {
    const file = Bun.file(path);

    if (await file.exists()) {
      rules.push(...parseProjectRules(await file.text()));
    }
  }

  return rules;
}

/**
 * Build the TTSR manager for a run: built-in defaults + project + learned rules.
 * Shared by the headless loop (run.ts) and the interactive session (session.ts).
 * Returns null when TTSR is disabled by flag.
 */
export async function initTtsrManager(
  cwd: string,
  report: Reporter,
  taskId: string
): Promise<TtsrManager | null> {
  const manager = new TtsrManager();

  for (const rule of DEFAULT_TTSR_RULES) {
    manager.addRule(rule);
  }

  let added = 0;

  for (const rule of await loadProjectTtsrRules(cwd)) {
    if (manager.addRule(rule)) {
      added += 1;
    }
  }

  if (added > 0) {
    report({
      kind: "ttsr",
      task: taskId,
      message: `loaded ${added} project/learned TTSR rule(s) from .tsforge/`,
    });
  }

  // Self-harness overlay rules (already schema-validated by parseOverlay) —
  // last so an overlay rule never displaces a same-named built-in/project rule
  // silently; addRule's first-wins dedup keeps the base harness authoritative.
  let overlayAdded = 0;

  for (const rule of activeOverlay()?.ttsrRules ?? []) {
    if (manager.addRule(rule)) {
      overlayAdded += 1;
    }
  }

  if (overlayAdded > 0) {
    report({
      kind: "ttsr",
      task: taskId,
      message: `loaded ${overlayAdded} self-harness overlay TTSR rule(s)`,
    });
  }

  return manager;
}

/**
 * Apply a TTSR interrupt: count it, report it, inject the corrective guidance as
 * a user message, and silence the offending RULE once its per-rule cap is hit —
 * one stubborn pattern must not blind the other rules for the rest of the task.
 * A raised global cap remains as a backstop so interrupts can't loop forever.
 * Shared by both loops; the caller decides what to do next (retry the turn).
 * Timing emission stays with the caller.
 */
export function applyTtsrInterrupt(
  ttsrFired: { ruleName: string; guidance: string },
  state: ILoopState,
  messages: IChatMessage[],
  report: Reporter,
  taskId: string,
  ttsrManager: TtsrManager | null
): void {
  state.ttsrInterrupts += 1;

  report({
    kind: "ttsr",
    task: taskId,
    message: `⚠ TTSR interrupted: ${ttsrFired.ruleName}`,
  });

  const ruleSilenced =
    ttsrManager?.recordInterrupt(ttsrFired.ruleName) ?? false;

  if (ruleSilenced) {
    report({
      kind: "tool",
      task: taskId,
      message: `TTSR rule ${ttsrFired.ruleName} silenced after repeated interrupts (other rules stay active)`,
    });
  }

  if (state.ttsrInterrupts >= TTSR_INTERRUPT_CAP) {
    report({
      kind: "tool",
      task: taskId,
      message: `TTSR disabled after ${state.ttsrInterrupts} interrupts (hit global cap)`,
    });

    ttsrManager?.disable();
  }

  messages.push({
    role: "user",
    content: `⚠ generation interrupted: ${ttsrFired.guidance} Rewrite the affected part without that pattern.`,
  });
}
