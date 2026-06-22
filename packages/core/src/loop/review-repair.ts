import type { ITask } from "../spec";
import type { IAgent } from "../agent";
import type { IProvider } from "../inference";
import { validate, runAccept } from "../validate";
import type { ErrorParser, ErrorSet } from "../validate";
import { reviewChange } from "./review/review-change";
import type { IVerifiedFinding } from "./review/review.types";
import { snapshotFiles, restoreFiles } from "./file-snapshot";
import type { Reporter } from "./loop.types";

/** Outcome of one post-green review-and-repair pass. */
export interface IReviewRepairResult {
  /** Verified findings the review surfaced (after the adversarial-verify pass). */
  findings: number;
  /** A repair was applied AND kept (the gate stayed green). */
  repaired: boolean;
  /** A repair was attempted but rolled back because it broke the gate. */
  reverted: boolean;
}

export interface IReviewRepairOptions {
  base?: string;
  staged?: boolean;
  parse?: ErrorParser;
  onEvent?: Reporter;
}

/** Turn verified findings into the gate-style error set the implement agent
 *  already knows how to consume (so the repair pass reuses the normal feedback
 *  channel — no second prompt format). */
function findingsToErrors(findings: readonly IVerifiedFinding[]): ErrorSet {
  return findings.map((f) => ({
    key: `review:${f.lens}:${f.file}:${f.line}`,
    file: f.file,
    line: f.line,
    rule: f.lens,
    message: `${f.claim} — ${f.reason}`,
  }));
}

/**
 * After a task is green, run the adversarial functional review (`reviewChange`)
 * and feed any VERIFIED findings into exactly ONE repair cycle: snapshot →
 * implement against the findings → re-gate → keep only if still green, else roll
 * back. The deterministic gate stays the authority for "done": a fix that breaks
 * it is reverted, never shipped. Distinct from `withGate` (which only makes the
 * review gate-aware) — this closes the loop by acting on what the review found.
 */
export async function reviewRepair(
  provider: IProvider,
  cwd: string,
  task: ITask,
  agent: IAgent,
  opts: IReviewRepairOptions = {}
): Promise<IReviewRepairResult> {
  const report: Reporter = opts.onEvent ?? ((): void => undefined);

  const log = (m: string): void => {
    report({ kind: "tool", task: task.id, message: m });
  };

  const review = await reviewChange(provider, cwd, {
    ...(opts.base === undefined ? {} : { base: opts.base }),
    staged: opts.staged ?? false,
    verify: true,
    log,
  });

  const { findings } = review;

  if (findings.length === 0) {
    report({
      kind: "fix",
      task: task.id,
      message: "post-green review: no verified findings",
    });

    return { findings: 0, repaired: false, reverted: false };
  }

  report({
    kind: "fix",
    task: task.id,
    message: `post-green review: ${findings.length} verified finding(s) — one repair pass`,
  });

  // The agent can only edit the task's declared scope, so that's all a revert
  // must restore.
  const snapshot = await snapshotFiles(cwd, task.files);

  // A throw mid-repair (agent error, fix-command crash, gate runner failure)
  // must still roll the workspace back — otherwise a half-applied edit batch is
  // left on disk. Restore, then rethrow so the caller still sees the failure.
  try {
    await agent.implement({
      cwd,
      task,
      errors: findingsToErrors(findings),
      cycle: 1,
      report,
    });

    if (task.fix !== undefined && task.fix.length > 0) {
      await runAccept({ ...task, accept: task.fix }, cwd);
    }

    const gate = await validate(task, cwd, opts.parse);

    if (gate.passed) {
      report({
        kind: "fix",
        task: task.id,
        message: "post-green review repair kept (gate green)",
      });

      return { findings: findings.length, repaired: true, reverted: false };
    }
  } catch (error) {
    await restoreFiles(cwd, snapshot);

    throw error;
  }

  await restoreFiles(cwd, snapshot);
  report({
    kind: "reverted",
    task: task.id,
    message: "review repair broke the gate",
  });
  report({
    kind: "fix",
    task: task.id,
    message: "post-green review repair broke the gate — reverted",
  });

  return { findings: findings.length, repaired: false, reverted: true };
}
