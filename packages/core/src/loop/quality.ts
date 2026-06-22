import { join } from "node:path";
import type { ITask } from "../spec";
import type { IAgent } from "../agent";
import type { IProvider } from "../inference";
import { validate, type ErrorParser } from "../validate";
import { runAccept } from "../validate";
import { judge } from "../eval";
import { qualityHints } from "./feedback";
import { snapshotFiles, restoreFiles } from "./file-snapshot";
import type { Reporter } from "./loop.types";

export interface IQualityResult {
  quality: number;
  notes: string;
  attempts: number;
}

export interface IQualityMeta {
  goal: string;
  criteria: string;
}

export interface IQualityOptions {
  /** Stop when quality reaches this (default 5). */
  target?: number;
  /** Max improvement attempts (default 2). */
  maxAttempts?: number;
  parse?: ErrorParser;
  onEvent?: Reporter;
}

/**
 * After a task is green, drive its *quality* up: judge it, and while it's below
 * target, feed the reviewer's critique back as an improvement instruction,
 * re-validate (must stay green), and re-judge — keeping only changes that both
 * keep the gate green and raise the score. Never ends below the green baseline.
 */
export async function qualityRepair(
  task: ITask,
  cwd: string,
  agent: IAgent,
  judgeProvider: IProvider,
  meta: IQualityMeta,
  opts: IQualityOptions = {}
): Promise<IQualityResult> {
  const target = opts.target ?? 5;
  const maxAttempts = opts.maxAttempts ?? 2;
  const report: Reporter = opts.onEvent ?? (() => undefined);

  let best = await score(task, cwd, judgeProvider, meta);

  report({
    kind: "fix",
    task: task.id,
    message: `quality ${best.quality}/5 — ${best.notes}`,
  });

  let attempts = 0;

  while (best.quality < target && attempts < maxAttempts) {
    attempts += 1;

    const snapshot = await snapshotFiles(cwd, task.files);

    // Turn the reviewer's prose into concrete bad→good guidance where we have a
    // card for the issue it named (the quality channel — these are idiomatic
    // problems the gate can't flag).
    const hints = qualityHints(best.notes);
    const guidance =
      hints.length > 0
        ? `\n\nConcrete fixes for the idioms it named:\n${hints}`
        : "";

    // Count this attempt's mutations so a revert subtracts the whole batch from
    // the accept rate, not just 1.
    let mutations = 0;

    const countingReport: Reporter = (event) => {
      if (event.kind === "edit" || event.kind === "create") {
        mutations += 1;
      }

      report(event);
    };

    await agent.implement({
      cwd,
      task,
      errors: [
        {
          key: "quality",
          message: `The code is green but a senior reviewer scored it ${best.quality}/5: "${best.notes}". Improve the code to address that critique.${guidance} Do NOT break the tests or the gate.`,
        },
      ],
      cycle: attempts,
      report: countingReport,
    });

    if (task.fix !== undefined && task.fix.length > 0) {
      await runAccept({ ...task, accept: task.fix }, cwd);
    }

    const gate = await validate(task, cwd, opts.parse);

    if (!gate.passed) {
      await restoreFiles(snapshot);
      report({
        kind: "reverted",
        task: task.id,
        count: mutations,
        message: "gate broken",
      });
      report({
        kind: "fix",
        task: task.id,
        message: `quality attempt ${attempts}: broke the gate — reverted`,
      });
      continue;
    }

    const next = await score(task, cwd, judgeProvider, meta);

    if (next.quality > best.quality) {
      best = next;
      report({
        kind: "fix",
        task: task.id,
        message: `quality ↑ ${best.quality}/5`,
      });
    } else {
      await restoreFiles(snapshot);
      report({
        kind: "reverted",
        task: task.id,
        count: mutations,
        message: "no quality gain",
      });
      report({
        kind: "fix",
        task: task.id,
        message: `quality attempt ${attempts}: no gain (${next.quality}/5) — kept previous`,
      });
    }
  }

  return { quality: best.quality, notes: best.notes, attempts };
}

interface IScore {
  quality: number;
  notes: string;
}

async function score(
  task: ITask,
  cwd: string,
  judgeProvider: IProvider,
  meta: IQualityMeta
): Promise<IScore> {
  let code = "";

  for (const file of task.files) {
    code += `// ${file}\n${await Bun.file(join(cwd, file)).text()}\n\n`;
  }

  const result = await judge(judgeProvider, {
    goal: meta.goal,
    criteria: meta.criteria,
    code,
  });

  return { quality: result.overall, notes: result.notes };
}
