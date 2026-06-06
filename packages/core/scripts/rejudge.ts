// Re-score EXISTING run outputs with a judge — no re-implementation. Its purpose
// is to resolve the OKR crux: is a local self-judged Q4 the code's true quality,
// or just the local model lowballing itself? Point it at a FLAGSHIP judge to find
// out (offline MEASURE only — never a runtime dependency):
//
//   TSFORGE_JUDGE_URL=https://… TSFORGE_JUDGE_MODEL=deepseek-… TSFORGE_JUDGE_KEY=… \
//     bun run packages/core/scripts/rejudge.ts money 5
//
// Without the JUDGE_* env it falls back to the local model (self-judge) and just
// reproduces the existing scores — so it warns when no flagship judge is set.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseSpec } from "../src/spec";
import { judge } from "../src/eval";
import { OpenAICompatibleProvider } from "../src/inference";
import { isRecord } from "../src/lib/guards";

const evalsRoot = join(import.meta.dir, "..", "..", "..", "evals");

const flagshipSet =
  process.env.TSFORGE_JUDGE_URL !== undefined ||
  process.env.TSFORGE_JUDGE_MODEL !== undefined;

const provider = new OpenAICompatibleProvider({
  baseUrl:
    process.env.TSFORGE_JUDGE_URL ??
    process.env.TSFORGE_BASE_URL ??
    "http://192.168.20.107:8000/v1",
  model:
    process.env.TSFORGE_JUDGE_MODEL ??
    process.env.TSFORGE_MODEL ??
    "qwen3.6-27b",
  apiKey: process.env.TSFORGE_JUDGE_KEY ?? process.env.TSFORGE_API_KEY,
});

async function resolveDirs(): Promise<string[]> {
  const args = process.argv.slice(2);

  if (args.length === 2 && /^\d+$/.test(args[1] ?? "")) {
    const prefix = args[0] ?? "";
    const count = Number(args[1]);
    const all = await readdir(evalsRoot, { withFileTypes: true });
    const dirs = all
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .map((d) => d.name)
      .sort();

    return dirs.slice(-count).map((name) => join(evalsRoot, name));
  }

  return args.map((a) => (a.startsWith("/") ? a : join(evalsRoot, a)));
}

/** The local (self-judge) overall score recorded at run time, if any. */
async function localScore(dir: string): Promise<number | undefined> {
  const file = Bun.file(join(dir, "result.json"));

  if (!(await file.exists())) {
    return undefined;
  }

  const data: unknown = JSON.parse(await file.text());

  return isRecord(data) && typeof data.quality === "number"
    ? data.quality
    : undefined;
}

async function specIn(dir: string): Promise<string | undefined> {
  const entries = await readdir(dir);

  return entries.find((e) => e.endsWith(".spec.md"));
}

const dirs = await resolveDirs();

if (!flagshipSet) {
  process.stdout.write(
    "⚠ No TSFORGE_JUDGE_URL/MODEL set — judging with the LOCAL model (self-judge). " +
      "Set a flagship judge to measure true quality.\n"
  );
}

process.stdout.write(
  `\n=== re-judge (${dirs.length} runs, judge=${flagshipSet ? "flagship" : "LOCAL self-judge"}) ===\n\n`
);
process.stdout.write("localQ  judgeOverall  corr  design  read  run\n");

for (const dir of dirs) {
  const specName = await specIn(dir);

  if (specName === undefined) {
    continue;
  }

  const spec = parseSpec(await Bun.file(join(dir, specName)).text());
  const task = spec.tasks[0];

  if (task === undefined) {
    continue;
  }

  const parts: string[] = [];

  for (const f of task.files) {
    const file = Bun.file(join(dir, f));

    if (await file.exists()) {
      parts.push(`// ${f}\n${await file.text()}`);
    }
  }

  if (parts.length === 0) {
    continue;
  }

  const score = await judge(provider, {
    goal: spec.title,
    criteria: await Bun.file(join(dir, specName)).text(),
    code: parts.join("\n\n"),
  });
  const local = await localScore(dir);
  const runId = dir.split("/").slice(-1)[0] ?? dir;

  process.stdout.write(
    [
      (local === undefined ? "-" : String(local)).padStart(6),
      String(score.overall).padStart(13),
      String(score.correctness).padStart(6),
      String(score.design).padStart(8),
      String(score.readability).padStart(6),
      `  ${runId}`,
    ].join("") + "\n"
  );
}
