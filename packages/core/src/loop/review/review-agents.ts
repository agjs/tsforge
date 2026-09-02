import { isRecord, isArray } from "../../lib/guards";
import type { IProvider } from "../../inference";
import type { TsService } from "../../lsp";
import type { PolicyMode, IPolicyRules } from "../../policy";
import { AgentScheduler, clampConcurrency } from "../../agent/agent-scheduler";
import { AgentRunner, TOOL_NAME } from "../../agent";
import { BUILTIN_SPECS } from "../../agent/builtin-specs";
import type { IAgentSpec } from "../../agent";
import type { Reporter } from "../loop.types";
import { buildTsService } from "../turn";
import {
  detectBase,
  collectChangedFiles,
  dedupeFindings,
} from "./review-change";
import type {
  IRepoFinding,
  IVerifiedFinding,
  IReviewReport,
  Severity,
} from "./review.types";

const REVIEW_TASK = "review";
const NOOP: Reporter = (): void => undefined;

export interface IReviewAgentsOptions {
  base?: string;
  staged?: boolean;
  /** Restrict to these workspace-relative files (intersected with the change). */
  files?: readonly string[];
  /** Reviewer model(s). Empty/absent ⇒ the passed main provider reviews. */
  reviewProviders?: readonly IProvider[];
  /** Rules the gate already fails on (told to the reviewer so it doesn't duplicate). */
  gateFailingRules?: readonly string[];
  concurrency?: number;
  /** Tree/attribution + streaming sink (the session reporter). */
  onEvent?: Reporter;
  /** Progress log (one line per step). */
  log?: (message: string) => void;
  tsService?: TsService | null;
  policyMode?: PolicyMode;
  policyRules?: IPolicyRules;
  contextWindow?: number;
}

/** The review-lens spec, widened for a real review agent: the full navigation
 *  toolset and a larger turn budget (reading around a change takes more turns than
 *  a one-file skim), and a distinct id per reviewer so each renders as its own tree
 *  node. Falls back to a built spec if the built-in is ever missing. */
function reviewSpecFor(index: number): IAgentSpec {
  const base = BUILTIN_SPECS.find((s) => s.id === "review-lens");

  return {
    id: `reviewer-${String(index)}`,
    description: "Reviews the whole change like a senior engineer.",
    kind: "chat",
    outputMode: "structured",
    tools: [
      TOOL_NAME.read,
      TOOL_NAME.search,
      TOOL_NAME.symbolSearch,
      TOOL_NAME.findReferences,
      TOOL_NAME.typeAt,
      TOOL_NAME.diagnostics,
      TOOL_NAME.gitContext,
    ],
    // Ceiling, not a target — a well-behaved reviewer finishes well under
    // this, so a generous cap costs nothing on typical changes.
    maxTurns: 100,
    systemPrompt:
      base?.systemPrompt ??
      "You are a REVIEW subagent. Review the change like a senior engineer.",
  };
}

/** The task text: orient the agent on the whole change, then let it navigate. */
function buildReviewTask(
  base: string,
  files: readonly string[],
  gateFailingRules: readonly string[]
): string {
  const gateNote =
    gateFailingRules.length > 0
      ? `\n\nThe automated gate already fails on: ${gateFailingRules.join(", ")}. Do NOT report those — the gate loop fixes them.`
      : "";

  return [
    `Review this change as a whole. Base: \`${base}\`.`,
    `Changed files (${String(files.length)}):\n${files.map((f) => `- ${f}`).join("\n")}`,
    "Read the ENTIRE change with `git_context` (op `diff`), then investigate properly: `read` the surrounding code, `find_references`/`type_at` to follow callers and definitions across files, `diagnostics` to check types. Judge the change the way a human reviewer would — not one file in isolation.",
    "Look for: logic errors, regressions in callers, missed edge cases, broken business rules, security holes (injection/secrets/authz), data/concurrency hazards, API/contract breaks, and drift from how this codebase already does the same thing.",
    "Report ONLY real issues, each with a `file:line` in `source` and a concrete failure scenario in `detail`. If the change is sound, say so with no findings.",
    gateNote,
  ].join("\n\n");
}

function toSeverity(confidence: unknown): Severity {
  if (confidence === "high") {
    return "error";
  }

  if (confidence === "low") {
    return "info";
  }

  return "warning"; // medium or unspecified
}

/** Parse an agent finding `source` like `src/a.ts:42` (or `:42-50`) into file+line.
 *  A finding with no usable `file:line` is dropped (the read-only mandate: no
 *  source ⇒ not investigated ⇒ not trustworthy). Exported for tests. */
export function locate(source: unknown): { file: string; line: number } | null {
  if (typeof source !== "string") {
    return null;
  }

  const m = /^(.+?):(\d+)/.exec(source.trim());

  if (m === null) {
    return null;
  }

  return { file: m[1] ?? "", line: Number(m[2]) };
}

/** Map one reviewer agent's structured `agent_result` into review findings.
 *  Exported for tests. */
export function findingsFrom(structured: unknown): {
  findings: IVerifiedFinding[];
  dropped: number;
} {
  const raw =
    isRecord(structured) && isArray(structured.findings)
      ? structured.findings
      : [];
  const findings: IVerifiedFinding[] = [];
  let dropped = 0;

  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.detail !== "string") {
      dropped += 1;
      continue;
    }

    const at = locate(entry.source);

    if (at === null) {
      dropped += 1; // no file:line ⇒ not grounded, drop it
      continue;
    }

    const detail = entry.detail.trim();
    const head = detail.split(/(?<=[.!?])\s/)[0] ?? detail;

    findings.push({
      file: at.file,
      line: at.line,
      severity: toSeverity(entry.confidence),
      lens: "review",
      claim: head,
      reason: detail,
      verified: true,
      verdict:
        typeof entry.confidence === "string" ? entry.confidence : "reviewed",
    });
  }

  return { findings, dropped };
}

/**
 * Agentic code review: each configured reviewer runs as a read-only AGENT (via
 * AgentRunner + the review-lens spec) with the WHOLE change and the codebase
 * navigation tools, so it reviews with real cross-file context like a human —
 * not one file in isolation. Reviewers run concurrently, each a live tree node.
 * Findings are pooled + deduped and returned as an IReviewReport (the card /
 * report / /reviewfix all consume that shape).
 */
export async function reviewAgents(
  provider: IProvider,
  cwd: string,
  opts: IReviewAgentsOptions = {}
): Promise<IReviewReport> {
  const log = opts.log ?? ((): void => undefined);
  const emit = opts.onEvent ?? NOOP;
  const staged = opts.staged ?? false;
  const gateFailingRules = [...(opts.gateFailingRules ?? [])];
  const base = await detectBase(cwd, opts.base);
  const collected = await collectChangedFiles(cwd, base, staged);
  const scope = opts.files === undefined ? null : new Set(opts.files);
  const files =
    scope === null
      ? collected.files
      : collected.files.filter((f) => scope.has(f));

  if (files.length === 0) {
    return {
      base,
      changedFiles: [],
      findings: [],
      rejected: 0,
      gateFailingRules,
      totalChangedFiles: collected.totalCandidates,
    };
  }

  const reviewers =
    opts.reviewProviders !== undefined && opts.reviewProviders.length > 0
      ? opts.reviewProviders
      : [provider];

  log(
    `reviewing ${files.length} changed file(s) vs ${base} with ${reviewers.length} reviewer(s)`
  );

  const svc = opts.tsService ?? (await buildTsService(cwd));
  const task = buildReviewTask(base, files, gateFailingRules);
  const scheduler = new AgentScheduler({
    concurrency: clampConcurrency(opts.concurrency),
  });

  const outcomes = await scheduler.runParallel(
    reviewers.map((reviewer, index) => ({
      id: `reviewer-${String(index)}`,
      run: async (
        signal: AbortSignal
      ): Promise<{ findings: IVerifiedFinding[]; dropped: number } | null> => {
        if (signal.aborted) {
          return null;
        }

        const spec = reviewSpecFor(index);
        const agentId = `${REVIEW_TASK}:${spec.id}`;
        const label =
          reviewers.length > 1 ? `reviewer ${String(index + 1)}` : "review";
        const node = {
          task: REVIEW_TASK,
          agentId,
          parentTask: REVIEW_TASK,
          message: label,
        };

        // Emit the lifecycle ourselves so each reviewer is a live tree node
        // (spawned → running → done). The runner's own token/tool events aren't
        // forwarded to the transcript (NOOP report) — the node is the progress.
        emit({ kind: "agent_spawned", ...node });
        emit({ kind: "agent_started", ...node });

        try {
          const result = await new AgentRunner(spec).run({
            provider: reviewer,
            cwd,
            parentTaskId: REVIEW_TASK,
            task,
            report: NOOP,
            signal,
            ...(opts.policyMode === undefined
              ? {}
              : { policyMode: opts.policyMode }),
            ...(opts.policyRules === undefined
              ? {}
              : { policyRules: opts.policyRules }),
            tsService: svc,
            ...(opts.contextWindow === undefined
              ? {}
              : { contextWindow: opts.contextWindow }),
          });

          if (result.status !== "done") {
            emit({ kind: "agent_result", ...node, passed: false });
            log(`  ${label}: failed (${result.status})`);

            return null;
          }

          const mapped = findingsFrom(result.structured);

          emit({
            kind: "agent_result",
            ...node,
            passed: true,
          });
          log(`  ${label}: ${String(mapped.findings.length)} finding(s)`);

          return mapped;
        } catch {
          emit({ kind: "agent_result", ...node, passed: false });
          log(`  ${label}: failed`);

          return null;
        }
      },
    }))
  );

  const raw: IRepoFinding[] = [];
  let rejected = 0;
  const failedReviewers: string[] = [];

  for (let i = 0; i < outcomes.length; i += 1) {
    const outcome = outcomes.at(i);

    if (outcome === null || outcome === undefined) {
      failedReviewers.push(
        reviewers.length > 1 ? `reviewer ${String(i + 1)}` : "review"
      );
      continue;
    }

    raw.push(...outcome.findings);
    rejected += outcome.dropped;
  }

  // A panel produces overlapping findings; collapse same file:line:lens.
  // (dedupeFindings returns them typed as IRepoFinding; re-assert the verified shape.)
  const verified: IVerifiedFinding[] = dedupeFindings(raw).map((f) => ({
    ...f,
    verified: true,
    verdict: "reviewed",
  }));

  log(`${verified.length} finding(s) after pooling`);

  return {
    base,
    changedFiles: files,
    findings: verified,
    rejected,
    gateFailingRules,
    totalChangedFiles: collected.totalCandidates,
    ...(failedReviewers.length > 0 ? { failedReviewers } : {}),
  };
}

/**
 * The review entry point the callers use. Review is AGENTIC and always has been the
 * only reviewer: {@link reviewAgents}. This alias keeps the call sites reading as
 * `review(...)`.
 */
export function review(
  provider: IProvider,
  cwd: string,
  opts: IReviewAgentsOptions = {}
): Promise<IReviewReport> {
  return reviewAgents(provider, cwd, opts);
}
