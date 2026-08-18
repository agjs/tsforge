/**
 * A/B: does model-driven delegation (spawn_agent subagents) actually earn its keep?
 *
 * Runs the SAME investigation task through a real Session twice — delegation ON
 * vs OFF — on the current endpoint, and reports the metrics that matter:
 *   - orchestrator PEAK prompt tokens  (the context-isolation claim: ON should be
 *     LOWER — the parent offloads reading into subagents' own contexts)
 *   - total tokens (orchestrator + subagents), turns, wall-clock, effective tok/s
 *   - the final answer (dumped to a file per arm, for a side-by-side quality read)
 *
 * The task is deliberately multi-part and read-heavy — the regime delegation is
 * FOR. On a small task both arms behave identically (the model correctly won't
 * delegate), so this picks a task where a difference, if any, will show.
 *
 * Config-agnostic + re-runnable: run under MTP-on AND MTP-off to fill the 2x2.
 *
 * Usage:
 *   TSFORGE_BASE_URL=http://192.168.20.108:8000/v1 \
 *   TSFORGE_MODEL=deepseek-ai/DeepSeek-V4-Flash \
 *   bun packages/core/scripts/delegation-ab-eval.ts [repeats=1] [cwd=tsforge repo]
 */
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Session, type Reporter, type ILoopEvent } from "../src/loop";
import type { SpawnAgentFn } from "../src/loop/tools";
import { AgentRunner } from "../src/agent";
import { formatResult, makeLimiter } from "../src/cli/spawn-runner";
import { findAgentSpec, loadAgentSpecs } from "../src/config/agent-specs";
import {
  loadTsforgeConfig,
  resolveAgentConcurrency,
} from "../src/config/tsforge-config";
import { OpenAICompatibleProvider } from "../src/inference";
import type {
  IProvider,
  ICompleteOptions,
  IModelResponse,
  IChatMessage,
} from "../src/inference";
import { resolveActiveModel, resolveModelByName } from "../src/models-config";
import { detectContextWindow, providerConfig } from "../src/cli/model-setup";
import { logsDir } from "../src/session-store";

const TASK =
  "Investigate these THREE things INDEPENDENTLY and report each with file:line " +
  "citations:\n" +
  "1) how the gate decides a run is done (what command runs, how pass/fail is read);\n" +
  "2) how AgentScheduler caps concurrency (the limiter/semaphore mechanism);\n" +
  "3) how tsforge.config.json is discovered and loaded (the walk-up + parsing).\n" +
  "Give a concise, cited summary of each — no code changes.";

interface ITally {
  peakPrompt: number;
  completion: number;
  prompt: number;
  calls: number;
}

const newTally = (): ITally => ({
  peakPrompt: 0,
  completion: 0,
  prompt: 0,
  calls: 0,
});

/** Wraps a provider to tally token usage into a shared record. */
class CountingProvider implements IProvider {
  constructor(
    private readonly inner: IProvider,
    private readonly tally: ITally
  ) {}

  async complete(
    messages: IChatMessage[],
    opts?: ICompleteOptions
  ): Promise<IModelResponse> {
    const res = await this.inner.complete(messages, opts);

    this.tally.calls += 1;

    if (res.usage !== undefined) {
      this.tally.peakPrompt = Math.max(
        this.tally.peakPrompt,
        res.usage.promptTokens
      );
      this.tally.prompt += res.usage.promptTokens;
      this.tally.completion += res.usage.completionTokens;
    }

    return res;
  }
}

/** A delegation runner that mirrors the real makeSpawnAgentFn but wraps each
 *  subagent's provider so we can tally subagent tokens separately. */
function makeCountingSpawnFn(opts: {
  specs: Awaited<ReturnType<typeof loadAgentSpecs>>;
  cwd: string;
  concurrency: number;
  contextWindow: number;
  defaultModel?: string;
  subTally: ITally;
}): SpawnAgentFn {
  const limit = makeLimiter(opts.concurrency);

  return async (req, { signal, report }): Promise<string> => {
    const spec = findAgentSpec(opts.specs, req.subagentType);

    if (spec === undefined) {
      return `spawn_agent: unknown subagent_type "${req.subagentType}"`;
    }

    return limit(async () => {
      const { entry } = await resolveModelByName(
        spec.model ?? opts.defaultModel
      );
      const provider = new CountingProvider(
        new OpenAICompatibleProvider(providerConfig(entry)),
        opts.subTally
      );
      const result = await new AgentRunner(spec).run({
        provider,
        cwd: opts.cwd,
        parentTaskId: req.parentTaskId,
        task: req.prompt,
        report,
        contextWindow: opts.contextWindow,
        policyMode: "bypassPermissions",
        ...(signal === undefined ? {} : { signal }),
      });

      return formatResult(spec.id, result);
    });
  };
}

interface IArmResult {
  arm: string;
  status: string;
  turns: number;
  wallMs: number;
  orch: ITally;
  sub: ITally;
  subSpawns: number;
  answer: string;
}

async function runArm(
  arm: "delegation-ON" | "delegation-OFF",
  cwd: string,
  contextWindow: number,
  entry: Parameters<typeof providerConfig>[0]
): Promise<IArmResult> {
  const orch = newTally();
  const sub = newTally();
  let subSpawns = 0;
  let answer = "";

  const report: Reporter = (e: ILoopEvent) => {
    if (e.kind === "agent_spawned") {
      subSpawns += 1;
    }

    if (e.kind === "message" && e.agentId === undefined) {
      answer = e.message; // the orchestrator's final answer
    }
  };

  const provider = new CountingProvider(
    new OpenAICompatibleProvider(providerConfig(entry)),
    orch
  );
  const session = await Session.create({
    provider,
    cwd,
    accept: "", // investigation only — no gate
    contextWindow,
    report,
    enableThinking: false,
  });

  if (arm === "delegation-ON") {
    const specs = await loadAgentSpecs(cwd, () => {
      // spec-load notices are irrelevant to the measurement
    });
    const config = await loadTsforgeConfig(cwd);

    session.setDelegation(
      specs,
      makeCountingSpawnFn({
        specs,
        cwd,
        concurrency: resolveAgentConcurrency(config),
        contextWindow,
        subTally: sub,
      })
    );
  }

  const start = performance.now();
  const result = await session.send(TASK);
  const wallMs = performance.now() - start;

  return {
    arm,
    status: result.status,
    turns: result.turns,
    wallMs,
    orch,
    sub,
    subSpawns,
    answer,
  };
}

function report(r: IArmResult): void {
  const wallS = r.wallMs / 1000;
  const totalCompletion = r.orch.completion + r.sub.completion;
  const tokPerSec = wallS > 0 ? totalCompletion / wallS : 0;

  process.stdout.write(
    `── ${r.arm} ──\n` +
      `  status=${r.status} turns=${r.turns} wall=${wallS.toFixed(1)}s\n` +
      `  ORCH  peakPrompt=${r.orch.peakPrompt} calls=${r.orch.calls} completion=${r.orch.completion}\n` +
      `  SUBS  spawned=${r.subSpawns} peakPrompt=${r.sub.peakPrompt} calls=${r.sub.calls} completion=${r.sub.completion}\n` +
      `  TOTAL completion=${totalCompletion} · effective tok/s=${tokPerSec.toFixed(1)}\n\n`
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const repeats = Math.max(1, parseInt(argv[0] ?? "1", 10));
  const cwd = argv[1] ?? join(import.meta.dir, "..", "..", "..");

  const { entry } = await resolveActiveModel();
  const contextWindow = (await detectContextWindow(entry)) ?? 131072;

  process.stdout.write(
    `A/B delegation eval — ${entry.model} @ ${entry.baseUrl}\n` +
      `cwd: ${cwd}\ncontext window: ${contextWindow} · ${repeats}× each arm\n\n`
  );

  const rows: IArmResult[] = [];

  for (let i = 0; i < repeats; i += 1) {
    // Fresh arm each iteration; ON then OFF so any endpoint drift hits both.
    for (const arm of ["delegation-ON", "delegation-OFF"] as const) {
      const r = await runArm(arm, cwd, contextWindow, entry);

      report(r);
      rows.push(r);
      writeFileSync(
        join(logsDir(), `ab-${arm}-${String(i)}.answer.txt`),
        r.answer
      );
    }
  }

  const on = rows.filter((r) => r.arm === "delegation-ON");
  const off = rows.filter((r) => r.arm === "delegation-OFF");
  const avg = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const onPeak = avg(on.map((r) => r.orch.peakPrompt));
  const offPeak = avg(off.map((r) => r.orch.peakPrompt));

  process.stdout.write(
    "=== summary (avg) ===\n" +
      `orchestrator peak prompt: ON ${onPeak.toFixed(0)} vs OFF ${offPeak.toFixed(0)} tok` +
      ` (ON is ${offPeak > 0 ? (((offPeak - onPeak) / offPeak) * 100).toFixed(0) : "?"}% ${onPeak < offPeak ? "LOWER" : "HIGHER"})\n` +
      `wall: ON ${avg(on.map((r) => r.wallMs / 1000)).toFixed(1)}s vs OFF ${avg(off.map((r) => r.wallMs / 1000)).toFixed(1)}s\n` +
      `subagents spawned per ON run: ${avg(on.map((r) => r.subSpawns)).toFixed(1)}\n` +
      `answers dumped to ${logsDir()}/ab-*.answer.txt\n`
  );

  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const detail =
      err instanceof Error ? (err.stack ?? err.message) : String(err);

    process.stderr.write(`ab-eval crashed: ${detail}\n`);
    process.exit(1);
  }
);
