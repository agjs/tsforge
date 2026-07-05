// A/B sweep over the REAL thing: full web-app builds from the benchmark catalog,
// not toy logic seeds. Orchestrates headless-build.ts as a subprocess per
// (feature-variant x repeat), toggling features via env (TSFORGE_WEB etc.),
// then aggregates pass-rate + turns into the same statistical report the logic
// sweep uses (Wilson intervals + two-proportion z-test vs a baseline variant).
//
// Each build is a from-scratch multi-entity app (up to webMaxTurns turns, large
// token spend), so this is GATED: it prints the plan and exits unless
// TSFORGE_WEB_CONFIRM=1 is set — a real run can cost hours and significant API
// credits on a cloud flagship.
//
// Run (dry-run plan):  TSFORGE_WEB_APP=saas-crm bun run packages/core/scripts/web-sweep.ts
// Run (for real):      TSFORGE_WEB_APP=saas-crm TSFORGE_FEATURE_VARIANTS=web \
//                        TSFORGE_WEB_REPEATS=2 TSFORGE_WEB_CONFIRM=1 \
//                        bun run packages/core/scripts/web-sweep.ts [react|vanilla]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveActiveModel } from "../src/models-config";
import { LOOP_LIMITS } from "../src/loop";
import {
  buildSweepReport,
  renderSweepReportMarkdown,
  type IRunRecord,
} from "../src/eval";
import { BENCHMARK_CATALOG, findBenchmarkApp } from "./benchmark-catalog";

/** A feature variant: dimension name -> "1" (on) | "0" (off). */
type IFeatureVariant = Record<string, string>;

/** The env var each known feature dimension toggles (mirrors sweep.ts so a web
 *  A/B reads the same flags the logic A/B does). */
const DIMENSION_ENV: Record<string, string> = {
  web: "TSFORGE_WEB",
};

/** Parse `TSFORGE_FEATURE_VARIANTS` ("ttsr,hashline") into the cartesian product
 *  of on/off per dimension. Empty -> a single unnamed baseline variant. */
function parseVariants(spec: string): IFeatureVariant[] {
  const dims = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let combos: IFeatureVariant[] = [{}];

  for (const dim of dims) {
    const next: IFeatureVariant[] = [];

    for (const combo of combos) {
      next.push({ ...combo, [dim]: "1" }, { ...combo, [dim]: "0" });
    }

    combos = next;
  }

  return combos;
}

/** The env overrides that realize a variant (only known dimensions are mapped). */
function variantEnv(variant: IFeatureVariant): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [dim, state] of Object.entries(variant)) {
    const key = DIMENSION_ENV[dim];

    if (key !== undefined) {
      env[key] = state === "1" ? "1" : "0";
    }
  }

  return env;
}

/** A stable label like "web=on"; "baseline" when no dimensions. */
function variantLabel(variant: IFeatureVariant): string {
  const parts = Object.entries(variant)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dim, state]) => `${dim}=${state === "1" ? "on" : "off"}`);

  return parts.length > 0 ? parts.join(",") : "baseline";
}

/** The baseline label to compare against: the all-off variant when there are
 *  dimensions (so deltas read as "the feature ON vs OFF"), else "baseline". */
function baselineLabel(variants: IFeatureVariant[]): string {
  const allOff = variants.find((v) =>
    Object.values(v).every((state) => state === "0")
  );

  return allOff === undefined ? "baseline" : variantLabel(allOff);
}

interface ISweepConfig {
  readonly slug: string;
  readonly framework: string;
  readonly variants: IFeatureVariant[];
  readonly repeats: number;
}

/** Sortable timestamp `YYYYMMDD-HHMMSS`. */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");

  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const EVALS_ROOT = join(import.meta.dir, "..", "..", "..", "evals");
const HEADLESS = join(import.meta.dir, "headless-build.ts");

/** Stream a child's stdout to our terminal while keeping a small tail buffer so
 *  we can parse its final `[status · N turn(s)]` summary line. */
async function teeStdout(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";

  for (;;) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    const text = decoder.decode(chunk.value);

    process.stdout.write(text);
    tail = `${tail}${text}`.slice(-4096);
  }

  return tail;
}

interface IBuildOutcome {
  readonly passed: boolean;
  readonly turns: number;
  readonly ms: number;
}

/** Run ONE headless web build in its own dir with the variant's feature env. */
async function runOneBuild(
  config: ISweepConfig,
  variant: IFeatureVariant,
  dir: string
): Promise<IBuildOutcome> {
  const started = performance.now();
  const proc = Bun.spawn(
    ["bun", HEADLESS, "--app", config.slug, config.framework, dir],
    {
      env: { ...process.env, ...variantEnv(variant) },
      stdout: "pipe",
      stderr: "inherit",
    }
  );
  const tail = await teeStdout(proc.stdout);
  const code = await proc.exited;
  const ms = performance.now() - started;
  const match = /\[\w+ · (\d+) turn/.exec(tail);

  return {
    passed: code === 0,
    turns: match?.[1] === undefined ? 0 : Number(match[1]),
    ms,
  };
}

/** Print the run plan and the cost warning. Returns the total build count. */
function printPlan(config: ISweepConfig, model: string): number {
  const total = config.variants.length * config.repeats;

  process.stdout.write(
    `\nWEB A/B SWEEP — the real thing (full app builds)\n` +
      `  app:       ${config.slug} (${config.framework})\n` +
      `  model:     ${model}\n` +
      `  variants:  ${config.variants.map(variantLabel).join(", ")}\n` +
      `  repeats:   ${config.repeats}\n` +
      `  builds:    ${total} total\n\n` +
      `Each build is a from-scratch multi-entity app: up to ` +
      `${LOOP_LIMITS.webMaxTurns} model turns, vite build + browser render gate, ` +
      `large token spend. ${total} of them runs SEQUENTIALLY and can take hours ` +
      `and significant API credits on a cloud flagship.\n`
  );

  return total;
}

/** Run the full sweep, returning one record per build for aggregation. */
async function runSweep(
  config: ISweepConfig,
  runDir: string
): Promise<IRunRecord[]> {
  const records: IRunRecord[] = [];
  let index = 0;
  const total = config.variants.length * config.repeats;

  for (const variant of config.variants) {
    const label = variantLabel(variant);

    for (let repeat = 1; repeat <= config.repeats; repeat += 1) {
      index += 1;
      const dir = join(runDir, `${label}-${String(repeat)}`);

      mkdirSync(dir, { recursive: true });
      process.stdout.write(
        `\n=== build ${String(index)}/${String(total)}: ${config.slug} ${label} #${String(repeat)} ===\n`
      );

      const outcome = await runOneBuild(config, variant, dir);

      records.push({
        label,
        passed: outcome.passed,
        cycles: outcome.turns,
        ms: outcome.ms,
      });
      process.stdout.write(
        `  -> ${outcome.passed ? "PASS" : "FAIL"} (${String(outcome.turns)} turns, ${(outcome.ms / 1000).toFixed(0)}s)\n`
      );
    }
  }

  return records;
}

/** Resolve the sweep config from env/argv, or print the catalog and exit. */
function resolveConfig(): ISweepConfig | undefined {
  const slug = process.env.TSFORGE_WEB_APP ?? "";
  const app = findBenchmarkApp(slug);

  if (app === undefined) {
    const list = BENCHMARK_CATALOG.map(
      (a, i) => `  ${String(i + 1)}. ${a.slug} — ${a.name}`
    ).join("\n");

    process.stderr.write(
      `set TSFORGE_WEB_APP to a benchmark slug. catalog:\n${list}\n`
    );

    return undefined;
  }

  const framework = process.argv[2] === "vanilla" ? "vanilla" : "react";
  const variants = parseVariants(process.env.TSFORGE_FEATURE_VARIANTS ?? "");
  const repeats = Math.max(1, Number(process.env.TSFORGE_WEB_REPEATS ?? "1"));

  return { slug: app.slug, framework, variants, repeats };
}

async function main(): Promise<void> {
  const config = resolveConfig();

  if (config === undefined) {
    process.exit(2);
  }

  const { entry } = await resolveActiveModel();

  printPlan(config, entry.model);

  if (process.env.TSFORGE_WEB_CONFIRM !== "1") {
    process.stdout.write(
      `\nDRY RUN — set TSFORGE_WEB_CONFIRM=1 to actually run these builds.\n`
    );
    process.exit(0);
  }

  const runDir = join(
    EVALS_ROOT,
    "runs",
    `web-sweep-${config.slug}-${stamp()}`
  );

  mkdirSync(runDir, { recursive: true });

  const records = await runSweep(config, runDir);
  const report = buildSweepReport(records, baselineLabel(config.variants));
  const markdown = renderSweepReportMarkdown(report);

  process.stdout.write(`\n${markdown}\n`);

  const reportPath = join(runDir, "report.json");

  writeFileSync(
    reportPath,
    `${JSON.stringify({ config, records, report }, null, 2)}\n`
  );
  process.stdout.write(`\nsaved ${reportPath}\n`);
}

await main();
