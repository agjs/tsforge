import { join } from "node:path";

import type { Reporter } from "./loop.types";
import type { ILoopState } from "./turn";
import type { IChatMessage } from "../inference";
import { TtsrManager, parseProjectRules, type ITtsrRule } from "./ttsr";
import { DEFAULT_TTSR_RULES } from "./ttsr-defaults";

const TTSR_INTERRUPT_CAP = 3;

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

  return manager;
}

/**
 * Apply a TTSR interrupt: count it, report it, inject the corrective guidance as
 * a user message, and disable the manager once the per-run cap is hit (so a
 * stubborn pattern can't loop forever). Shared by both loops; the caller decides
 * what to do next (retry the turn). Timing emission stays with the caller.
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

  if (state.ttsrInterrupts >= TTSR_INTERRUPT_CAP) {
    report({
      kind: "tool",
      task: taskId,
      message: `TTSR disabled after ${state.ttsrInterrupts} interrupts (hit cap)`,
    });

    ttsrManager?.disable();
  }

  messages.push({
    role: "user",
    content: `⚠ generation interrupted: ${ttsrFired.guidance} Rewrite the affected part without that pattern.`,
  });
}
