import type { ITask } from "../spec";
import type { IAgent } from "../agent";
import type { IProvider } from "../inference";
import { validate, type ErrorParser } from "../validate";
import { runAccept } from "../validate";
import { readFiles } from "../lib/fs";
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

  const initial = await score(task, cwd, judgeProvider, meta);

  // No usable judge signal (unparseable/errored response, or nothing in scope to
  // assess): do NOT enter the improvement loop. Feeding the generator "a reviewer
  // scored you 0/5: <error>" is a nonsense critique it can't act on — observed
  // live, the model spirals on it and burns attempts for zero gain. Keep the green
  // baseline and move on.
  if (!initial.scored) {
    report({
      kind: "fix",
      task: task.id,
      message: `quality not scored (${initial.notes}) — skipping quality pass`,
    });

    // ZERO, not the judge's number. The acceptance guard reads a floor of 1 for
    // anything the candidate caused (see IJudgeScore.outcome), but IQualityResult
    // has no `scored` field and 0 is this consumer's long-standing "no signal" —
    // so forwarding the floor here would record 1/5 in the sweep as though a
    // reviewer had judged the code and found it poor. Two conventions, because
    // the two callers ask different questions.
    return { quality: 0, notes: initial.notes, attempts: 0 };
  }

  let best = initial;

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

    // A throw mid-attempt (agent error, fix-command crash, gate runner failure)
    // must still roll the workspace back — otherwise a half-applied edit batch is
    // left on disk over the green baseline. Restore, then rethrow so the caller
    // still sees the failure (mirrors review-repair.ts).
    let gate;

    try {
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

      gate = await validate(task, cwd, opts.parse);
    } catch (error) {
      await restoreFiles(snapshot);

      throw error;
    }

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
  /** False when there was no real judge signal (unparseable, or nothing in scope)
   *  — the caller must not treat it as an actionable 0/5 critique. */
  scored: boolean;
}

async function score(
  task: ITask,
  cwd: string,
  judgeProvider: IProvider,
  meta: IQualityMeta
): Promise<IScore> {
  // Expand the editable scope through the shared walker (globs, dedupe, size-cap)
  // — the same path `scopeCode`/`snapshotFiles` take. A literal per-file read here
  // would throw ENOENT on a glob scope (e.g. `src/**/*.ts`), which `ITask.files`
  // explicitly allows.
  const views = await readFiles(cwd, task.files);

  // Nothing resolved (an empty glob match, or every file over the size cap): there
  // is no artifact to assess. Return the floor WITHOUT calling the judge — an empty
  // code window scores unpredictably and burns an LLM call. Degrade, never throw:
  // quality repair is a best-effort post-green pass, not a gate.
  if (views.length === 0) {
    return { quality: 0, notes: "no files in scope to judge", scored: false };
  }

  const code = views.map((v) => `// ${v.path}\n${v.content}\n`).join("\n");

  const result = await judge(judgeProvider, {
    goal: meta.goal,
    criteria: meta.criteria,
    code,
  });

  return {
    quality: result.overall,
    notes: result.notes,
    scored: result.scored,
  };
}
