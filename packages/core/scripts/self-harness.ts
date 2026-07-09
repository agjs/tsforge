// Self-Harness (arXiv 2606.09498): the active model improves tsforge's own
// harness via a regression-gated loop — evaluate → mine weaknesses → propose
// minimal overlay edits → validate (Δin≥0 ∧ Δho≥0 ∧ max>0) → merge.
// The outcome is a PR-ready overlay + audit report for HUMAN review; nothing
// is auto-installed.
//
// Run:  bun packages/core/scripts/self-harness.ts [--rounds 3] [--width 3]
//         [--repeats 1] [--held-in a,b,..] [--held-out c,d,..]
//         [--dry-run] [--no-judge]
// Judge override (else the active model judges): TSFORGE_JUDGE_URL/MODEL/KEY.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OpenAICompatibleProvider } from "../src/inference";
import { resolveActiveModel, resolveApiKey } from "../src/models-config";
import { providerConfig } from "../src/cli";
import {
  emitReport,
  evaluateHarness,
  mineWeaknesses,
  modelSlug,
  propose,
  resolveSplits,
  runSelfHarness,
  emptyOverlay,
  type HarnessEvaluator,
  type ISplits,
} from "../src/self-harness";
import type { IProvider } from "../src/inference";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;

  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function csv(value: string | undefined): string[] | undefined {
  const items = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return items.length > 0 ? items : undefined;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");

  return `${String(d.getFullYear())}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const rounds = Number(argValue("rounds") ?? "3");
const width = Number(argValue("width") ?? "3");
const repeats = Number(argValue("repeats") ?? "1");
const dryRun = hasFlag("dry-run");
const useJudge = !hasFlag("no-judge");

const evalsRoot = join(import.meta.dir, "..", "..", "..", "evals");
const corpusDir = join(evalsRoot, "corpus");

const { name: modelName, entry } = await resolveActiveModel();
const provider: IProvider = new OpenAICompatibleProvider(providerConfig(entry));

// Judge convention mirrors the eval sweep: explicit TSFORGE_JUDGE_* wins, else
// the active model judges its own solutions (still a usable non-regression
// signal — the SAME judge scores baseline and candidate).
const judgeOverridden =
  process.env.TSFORGE_JUDGE_URL !== undefined ||
  process.env.TSFORGE_JUDGE_MODEL !== undefined;
const judgeProvider: IProvider | undefined = useJudge
  ? new OpenAICompatibleProvider(
      judgeOverridden
        ? {
            baseUrl: process.env.TSFORGE_JUDGE_URL ?? entry.baseUrl,
            model: process.env.TSFORGE_JUDGE_MODEL ?? entry.model,
            apiKey: process.env.TSFORGE_JUDGE_KEY ?? resolveApiKey(entry),
          }
        : providerConfig(entry)
    )
  : undefined;

const splits: ISplits = await resolveSplits(
  corpusDir,
  csv(argValue("held-in")),
  csv(argValue("held-out"))
);

const outDir = join(
  evalsRoot,
  "self-harness",
  `${modelSlug(entry.model)}-${stamp()}`
);

await mkdir(outDir, { recursive: true });

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

say(`self-harness — model ${entry.model} (registry: ${modelName})`);
say(`  held-in:  ${splits.heldIn.join(", ")}`);
say(`  held-out: ${splits.heldOut.join(", ")}`);
say(
  `  rounds=${String(rounds)} width=${String(width)} repeats=${String(repeats)} judge=${useJudge ? "on" : "off"}${dryRun ? " DRY-RUN" : ""}`
);
say(`  out: ${outDir}`);

let evaluations = 0;

/** The real corpus evaluator: one directory per (label, split); sequential —
 *  the primary endpoint is single-connection. */
const evaluator: HarnessEvaluator = async (overlay, s, label) => {
  evaluations += 1;

  say(
    `  [eval ${String(evaluations)}] ${label}: held-in (${String(s.heldIn.length)} task(s) × ${String(repeats)})`
  );

  const heldIn = await evaluateHarness(s.heldIn, {
    corpusDir,
    runsDir: join(outDir, "runs", label, "held-in"),
    provider,
    repeats,
    overlay,
    ...(judgeProvider === undefined ? {} : { judgeProvider }),
    log: say,
  });

  say(
    `  [eval ${String(evaluations)}] ${label}: held-out (${String(s.heldOut.length)} task(s) × ${String(repeats)})`
  );

  const heldOut = await evaluateHarness(s.heldOut, {
    corpusDir,
    runsDir: join(outDir, "runs", label, "held-out"),
    provider,
    repeats,
    overlay,
    ...(judgeProvider === undefined ? {} : { judgeProvider }),
    log: say,
  });

  return {
    evaluation: { heldIn: heldIn.score, heldOut: heldOut.score },
    heldInRuns: heldIn.runs,
  };
};

if (dryRun) {
  // Mine + propose from ONE held-in evaluation; no candidate validation runs.
  say(
    "dry-run: evaluating the current harness on held-in, then mining + proposing only"
  );

  const heldIn = await evaluateHarness(splits.heldIn, {
    corpusDir,
    runsDir: join(outDir, "runs", "dry-run", "held-in"),
    provider,
    repeats,
    overlay: null,
    log: say,
  });
  const bundle = mineWeaknesses(heldIn.runs);

  say(
    `mined ${String(bundle.patterns.length)} pattern(s) from ${String(bundle.failedRuns)}/${String(bundle.totalRuns)} failed run(s):`
  );

  for (const p of bundle.patterns) {
    say(
      `  - ${p.signature} ×${String(p.support)} (${p.taskIds.join(", ")}) — ${p.mechanism}`
    );
  }

  const notes: string[] = [];
  const candidates = await propose(bundle, {
    provider,
    width,
    current: emptyOverlay(),
    idPrefix: "dry",
    notes,
  });

  for (const c of candidates) {
    say(
      `candidate ${c.id}: targets ${c.audit.targetPattern} via ${c.audit.surface}`
    );
    say(`  effect: ${c.audit.expectedEffect}`);
    say(JSON.stringify(c.patch, null, 2));
  }

  for (const n of notes) {
    say(`note: ${n}`);
  }

  await Bun.write(
    join(outDir, "dry-run.json"),
    JSON.stringify({ bundle, candidates, notes }, null, 2)
  );
  say(`saved ${join(outDir, "dry-run.json")}`);
  process.exit(0);
}

const lineage = await runSelfHarness({
  model: entry.model,
  rounds,
  width,
  splits,
  provider,
  evaluator,
  log: say,
});

const report = emitReport(lineage);

await Bun.write(join(outDir, "overlay.json"), report.overlayJson);
await Bun.write(join(outDir, "report.md"), report.markdown);
await Bun.write(join(outDir, "lineage.json"), JSON.stringify(lineage, null, 2));

const acceptedTotal = lineage.rounds.reduce(
  (acc, r) => acc + r.acceptedIds.length,
  0
);

say("");
say(
  `done — ${String(acceptedTotal)} edit(s) accepted across ${String(lineage.rounds.length)} round(s)`
);
say(`  overlay:  ${join(outDir, "overlay.json")}`);
say(`  report:   ${join(outDir, "report.md")}`);
say(`  lineage:  ${join(outDir, "lineage.json")}`);
say(
  "review the report; installing the overlay is YOUR decision (see its install path inside)."
);
