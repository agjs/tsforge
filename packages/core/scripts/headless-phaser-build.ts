// Drive the Phaser generate-then-fill loop non-interactively. Point this at a
// scaffolded Phaser clone with an approved plan:
//
//   bun run packages/core/scripts/headless-phaser-build.ts "<goal>" <clone-dir>
import { OpenAICompatibleProvider, PROVIDER_LIMITS } from "../src/inference";
import { resolveActiveModel, resolveApiKey } from "../src/models-config";
import { LOOP_LIMITS, type Reporter } from "../src/loop";
import { runPhaserBuild } from "../src/loop/phaser/build";
import { createPhaserHostSession } from "../src/loop/phaser/build-session";
import { bunExec } from "../src/loop/phaser/exec";
import { loadApprovedPlan } from "../src/loop/planning/plan-store";
import { phaserPlanSchema } from "../src/loop/phaser/plan-extension";
import { detectContextWindow } from "../src/cli/model-setup";

async function main(): Promise<void> {
  const prompt = process.argv[2] ?? "add a coin pickup";
  const dir = process.argv[3] ?? process.cwd();
  const resolved = await resolveActiveModel();
  const entry = resolved.entry;
  const provider = new OpenAICompatibleProvider({
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    maxTokens: entry.maxTokens ?? PROVIDER_LIMITS.maxTokens,
  });
  const contextWindow =
    entry.contextWindow ??
    (await detectContextWindow(provider.config)) ??
    32_768;

  const report: Reporter = (event) => {
    if (event.message.length > 0) {
      process.stdout.write(`${event.message}\n`);
    }
  };

  const plan = await loadApprovedPlan(dir, phaserPlanSchema);

  if (plan === null) {
    process.stderr.write("no approved Phaser plan in this directory\n");
    process.exitCode = 1;

    return;
  }

  const host = await createPhaserHostSession({
    provider,
    cwd: dir,
    contextWindow,
    maxTurns: LOOP_LIMITS.webMaxTurns,
    report,
  });

  const result = await runPhaserBuild({
    cwd: dir,
    plan,
    host,
    exec: bunExec,
    echo: (s) => {
      process.stdout.write(s);
    },
  });

  process.stdout.write(
    `\n[phaser ${result.status} · ${String(result.completed.length)} slice(s) · ${prompt}]\n`
  );
  process.exitCode = result.status === "done" ? 0 : 1;
}

await main();
