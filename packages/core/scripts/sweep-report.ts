// Turn a sweep's `sweep-<seed>-<ts>.json` into a statistical Markdown report:
// per-variant pass rate with a 95% Wilson interval and, when TSFORGE_BASELINE
// names a variant, a two-proportion significance test against it.
//
// Run:  bun run packages/core/scripts/sweep-report.ts [sweep.json]
//   (no arg → the newest sweep-*.json under evals/runs)
//   TSFORGE_BASELINE="git=off,script=off temp=0"  # optional baseline label
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards";
import {
  buildSweepReport,
  renderSweepReportMarkdown,
  type IRunRecord,
} from "../src/eval";
import { FAILURE_CLASS, type FailureClass } from "../src/eval/failure-class";

const RUNS_DIR = "evals/runs";

async function newestSweep(): Promise<string> {
  const names = (await readdir(RUNS_DIR))
    .filter((n) => n.startsWith("sweep-") && n.endsWith(".json"))
    .sort();
  const latest = names.at(-1);

  if (latest === undefined) {
    throw new Error(`no sweep-*.json found in ${RUNS_DIR}`);
  }

  return join(RUNS_DIR, latest);
}

/** True for a value that is one of the known failure classes — a guard, so a
 *  hand-edited or older sweep JSON cannot smuggle an arbitrary string through. */
function isFailureClass(value: unknown): value is FailureClass {
  if (typeof value !== "string") {
    return false;
  }

  // Widened to string[] so the lookup needs no type assertion (house rule).
  const known: readonly string[] = Object.values(FAILURE_CLASS);

  return known.includes(value);
}

function toRecords(value: unknown): IRunRecord[] {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return [];
  }

  const out: IRunRecord[] = [];

  for (const r of value.records) {
    if (
      isRecord(r) &&
      typeof r.label === "string" &&
      typeof r.passed === "boolean" &&
      typeof r.cycles === "number" &&
      typeof r.ms === "number"
    ) {
      // Rehydrate EVERY metric the record can carry. Dropping fields here meant a
      // re-rendered report showed empty cost columns (and had already been losing
      // loc / failureClass) for data that was present on disk.
      out.push({
        label: r.label,
        passed: r.passed,
        cycles: r.cycles,
        ms: r.ms,
        ...(typeof r.quality === "number" ? { quality: r.quality } : {}),
        ...(typeof r.loc === "number" ? { loc: r.loc } : {}),
        ...(typeof r.tokensOut === "number" ? { tokensOut: r.tokensOut } : {}),
        ...(typeof r.costPerAcceptedChange === "number"
          ? { costPerAcceptedChange: r.costPerAcceptedChange }
          : {}),
        ...(isFailureClass(r.failureClass)
          ? { failureClass: r.failureClass }
          : {}),
      });
    }
  }

  return out;
}

const fileArg = process.argv[2];
const baseline = process.env.TSFORGE_BASELINE;
const path = fileArg ?? (await newestSweep());
const parsed: unknown = JSON.parse(await Bun.file(path).text());
const records = toRecords(parsed);

if (records.length === 0) {
  process.stderr.write(`no run records in ${path}\n`);
  process.exit(1);
}

const report = buildSweepReport(records, baseline);
const markdown = renderSweepReportMarkdown(report);
const outPath = path.replace(/\.json$/, ".report.md");

await Bun.write(outPath, `${markdown}\n`);
process.stdout.write(`${markdown}\n\nwrote ${outPath}\n`);
