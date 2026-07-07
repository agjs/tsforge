/**
 * Delegation eval: is `agents.concurrency > 1` ACTUALLY faster on the live
 * endpoint, and do read-only subagents ever fail exploration?
 *
 * Runs the same fan-out of `explore` subagents (one per subsystem) against the
 * REAL model at several concurrency caps, and reports for each cap:
 *   - wall-clock (the number that matters — does parallelism shorten it?)
 *   - aggregate completion tok/s (does the endpoint serve N streams faster than
 *     one? if MTP already saturates the GPU, aggregate ≈ single-stream and cap>1
 *     is a wash)
 *   - per-agent status / turns / PEAK prompt tokens / failure text (so a 400
 *     context-overflow is captured verbatim, not swallowed)
 *
 * Usage:
 *   TSFORGE_BASE_URL=http://192.168.20.108:8000/v1 \
 *   TSFORGE_MODEL=deepseek-ai/DeepSeek-V4-Flash \
 *   bun packages/core/scripts/agents-concurrency-eval.ts [caps=1,2,4] [repeats=1]
 */
import { performance } from "node:perf_hooks";
import { AgentRunner, type IAgentResult } from "../src/agent";
import { BUILTIN_SPECS } from "../src/agent/builtin-specs";
import type {
  IProvider,
  ICompleteOptions,
  IModelResponse,
  IChatMessage,
} from "../src/inference";
import { OpenAICompatibleProvider } from "../src/inference";
import { resolveActiveModel } from "../src/models-config";
import { detectContextWindow, providerConfig } from "../src/cli/model-setup";
import { makeLimiter } from "../src/cli/spawn-runner";
import type { ILoopEvent, Reporter } from "../src/loop";

// One exploration task per subsystem — mirrors the real screenshot fan-out.
const TASKS: readonly { label: string; prompt: string }[] = [
  {
    label: "loop",
    prompt:
      "Explore the loop subsystem in packages/core/src/loop. Trace how a turn runs and how the gate decides a run is done. Report the key files and functions with file:line citations.",
  },
  {
    label: "rule-packs",
    prompt:
      "Explore the rule-packs subsystem in packages/core/src/stack-detection and the ESLint rule packs. Report how packs are selected and applied, with file:line citations.",
  },
  {
    label: "meta-rules",
    prompt:
      "Explore the meta-rules subsystem. Report what meta-rules exist and how they are enforced, with file:line citations.",
  },
  {
    label: "cli-config",
    prompt:
      "Explore the CLI and config subsystem in packages/core/src/cli and packages/core/src/config. Report how the config is loaded and how the REPL boots, with file:line citations.",
  },
];

interface IAgentStat {
  label: string;
  status: IAgentResult["status"];
  turns: number;
  durationMs: number;
  peakPromptTokens: number;
  completionTokens: number;
  failure: string | null;
}

/** Wraps a provider to tally real token usage and capture the exact failure. */
class CountingProvider implements IProvider {
  peakPromptTokens = 0;
  completionTokens = 0;
  failure: string | null = null;

  constructor(private readonly inner: IProvider) {}

  async complete(
    messages: IChatMessage[],
    opts?: ICompleteOptions
  ): Promise<IModelResponse> {
    try {
      const res = await this.inner.complete(messages, opts);

      if (res.usage !== undefined) {
        this.peakPromptTokens = Math.max(
          this.peakPromptTokens,
          res.usage.promptTokens
        );
        this.completionTokens += res.usage.completionTokens;
      }

      return res;
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);

      throw err;
    }
  }
}

async function runOneCap(
  cap: number,
  entry: Parameters<typeof providerConfig>[0],
  cwd: string
): Promise<{ cap: number; wallMs: number; stats: IAgentStat[] }> {
  const limit = makeLimiter(cap);
  const explore = BUILTIN_SPECS.find((s) => s.id === "explore");

  if (explore === undefined) {
    throw new Error("explore spec missing");
  }

  const silent: Reporter = (_e: ILoopEvent) => {
    // discard — this eval measures timing/tokens, not rendered output
  };

  const start = performance.now();

  const stats = await Promise.all(
    TASKS.map((task, i) =>
      limit(async (): Promise<IAgentStat> => {
        const counter = new CountingProvider(
          new OpenAICompatibleProvider(providerConfig(entry))
        );
        const agentStart = performance.now();
        const result = await new AgentRunner(explore).run({
          provider: counter,
          cwd,
          parentTaskId: `cap${cap}-${i}`,
          task: task.prompt,
          report: silent,
          policyMode: "bypassPermissions",
        });

        return {
          label: task.label,
          status: result.status,
          turns: result.turns,
          durationMs: performance.now() - agentStart,
          peakPromptTokens: counter.peakPromptTokens,
          completionTokens: counter.completionTokens,
          failure: counter.failure,
        };
      })
    )
  );

  return { cap, wallMs: performance.now() - start, stats };
}

const winText = (window: number, fallback: string): string =>
  window > 0 ? String(window) : fallback;

/** Print one cap's run and return its one-line summary. */
function reportCap(
  cap: number,
  runLabel: string,
  wallMs: number,
  stats: readonly IAgentStat[],
  window: number
): string {
  const wallS = wallMs / 1000;
  const aggCompletion = stats.reduce((n, s) => n + s.completionTokens, 0);
  const peak = Math.max(...stats.map((s) => s.peakPromptTokens));
  const fails = stats.filter((s) => s.status === "error");
  const tokPerSec = wallS > 0 ? aggCompletion / wallS : 0;

  process.stdout.write(
    `── cap ${cap}${runLabel} ──\n` +
      `  wall: ${wallS.toFixed(1)}s · agg completion: ${aggCompletion} tok · agg tok/s: ${tokPerSec.toFixed(1)} · peak prompt: ${peak}/${winText(window, "?")} tok\n`
  );

  for (const s of stats) {
    const flag =
      s.status === "done" ? "✓" : s.status === "error" ? "✗" : s.status;
    const fail =
      s.failure === null ? "" : `\n        FAIL: ${s.failure.slice(0, 300)}`;

    process.stdout.write(
      `    ${flag} ${s.label.padEnd(12)} turns=${s.turns} ${(s.durationMs / 1000).toFixed(1)}s peakPrompt=${s.peakPromptTokens} completion=${s.completionTokens}${fail}\n`
    );
  }

  process.stdout.write("\n");

  return `cap ${cap}: wall ${wallS.toFixed(1)}s · ${tokPerSec.toFixed(1)} agg tok/s · ${fails.length}/${stats.length} failed · peak ${peak} tok`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const caps = (argv[0] ?? "1,2,4")
    .split(",")
    .map((s) => Math.max(1, parseInt(s, 10)));
  const repeats = Math.max(1, parseInt(argv[1] ?? "1", 10));

  const active = await resolveActiveModel();
  const window = (await detectContextWindow(active.entry)) ?? 0;

  process.stdout.write(
    `model: ${active.entry.model} @ ${active.entry.baseUrl}\n` +
      `context window: ${winText(window, "unknown")} tokens · ${TASKS.length} explore agents · caps [${caps.join(", ")}] · ${repeats}× each\n\n`
  );

  const rows: string[] = [];

  for (const cap of caps) {
    for (let r = 0; r < repeats; r += 1) {
      const { wallMs, stats } = await runOneCap(
        cap,
        active.entry,
        process.cwd()
      );
      const runLabel = repeats > 1 ? ` (run ${r + 1})` : "";

      rows.push(reportCap(cap, runLabel, wallMs, stats, window));
    }
  }

  process.stdout.write("=== summary ===\n" + rows.join("\n") + "\n");

  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const detail =
      err instanceof Error ? (err.stack ?? err.message) : String(err);

    process.stderr.write(`eval crashed: ${detail}\n`);
    process.exit(1);
  }
);
