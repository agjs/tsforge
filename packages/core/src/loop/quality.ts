import { join } from "node:path";
import type { ITask } from "../spec";
import type { IAgent } from "../agent";
import type { IProvider } from "../inference";
import { validate, type ErrorParser } from "../validate";
import { runAccept } from "../validate";
import { judge } from "../eval/judge";
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

    const snapshot = await snapshotFiles(task, cwd);

    await agent.implement({
      cwd,
      task,
      errors: [
        {
          key: "quality",
          message: `The code is green but a senior reviewer scored it ${best.quality}/5: "${best.notes}". Improve the code to address that critique. Do NOT break the tests or the gate.`,
        },
      ],
      cycle: attempts,
      report,
    });

    if (task.fix !== undefined && task.fix.length > 0) {
      await runAccept({ ...task, accept: task.fix }, cwd);
    }

    const gate = await validate(task, cwd, opts.parse);

    if (!gate.passed) {
      await restoreFiles(snapshot, cwd);
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
      await restoreFiles(snapshot, cwd);
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

async function snapshotFiles(
  task: ITask,
  cwd: string
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  for (const file of task.files) {
    const handle = Bun.file(join(cwd, file));

    if (await handle.exists()) {
      snapshot.set(file, await handle.text());
    }
  }

  return snapshot;
}

async function restoreFiles(
  snapshot: Map<string, string>,
  cwd: string
): Promise<void> {
  for (const [file, content] of snapshot) {
    await Bun.write(join(cwd, file), content);
  }
}
