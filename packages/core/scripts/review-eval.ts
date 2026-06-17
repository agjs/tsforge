// Eval for `tsforge review`: run the reviewer against repos with PLANTED bugs
// (known ground truth) and measure recall (did it find the plant?) and false
// positives (did it invent issues?), A/B'ing the adversarial-verify pass on/off.
// Review can't be test-graded (a test leaks the answer), so we grade against
// planted defects instead. Writes a record to evals/runs/.
//
// Run: bun run packages/core/scripts/review-eval.ts   (uses ~/.tsforge/models.json)
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatibleProvider } from "../src/inference";
import { reviewChange } from "../src/loop/review";
import { resolveActiveModel, resolveApiKey } from "../src/models-config";

interface IScenario {
  id: string;
  file: string;
  /** The 1-based line the planted bug sits on. */
  line: number;
  /** Committed (correct) version. */
  good: string;
  /** Working-tree (buggy) version — the change under review. */
  bad: string;
}

const SCENARIOS: IScenario[] = [
  {
    id: "correctness-reversed-subtraction",
    file: "discount.ts",
    line: 2,
    good: "export function discount(price: number, off: number): number {\n  return price - off;\n}\n",
    bad: "export function discount(price: number, off: number): number {\n  return off - price;\n}\n",
  },
  {
    id: "edge-case-unguarded-index",
    file: "host.ts",
    line: 2,
    good: 'export function host(url: string): string {\n  return url.split("//")[1] ?? "";\n}\n',
    bad: 'export function host(url: string): string {\n  return url.split("//")[1].split("/")[0];\n}\n',
  },
  {
    id: "business-logic-missing-rounding",
    file: "tax.ts",
    line: 2,
    good: "export function withTax(cents: number): number {\n  return Math.round(cents * 1.2);\n}\n",
    bad: "export function withTax(cents: number): number {\n  return cents * 1.2;\n}\n",
  },
];

async function buildProvider(): Promise<OpenAICompatibleProvider> {
  const { entry } = await resolveActiveModel();

  return new OpenAICompatibleProvider({
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: resolveApiKey(entry),
    maxTokens: entry.maxTokens ?? 8192,
    reasoning: entry.reasoning,
    reasoningEffort: entry.reasoningEffort,
    extraBody: entry.extraBody,
    extraHeaders: entry.extraHeaders,
  });
}

function setup(s: IScenario): string {
  const dir = mkdtempSync(join(tmpdir(), `review-${s.id}-`));
  const git = (...a: string[]): void =>
    void execFileSync("git", a, { cwd: dir, stdio: "ignore" });

  writeFileSync(
    join(dir, "tsconfig.json"),
    '{"compilerOptions":{"strict":true,"skipLibCheck":true},"include":["*.ts"]}'
  );
  writeFileSync(join(dir, s.file), s.good);
  git("init", "-q");
  git("config", "user.email", "e@e.e");
  git("config", "user.name", "e");
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
  writeFileSync(join(dir, s.file), s.bad); // the buggy change under review

  return dir;
}

interface IScore {
  found: boolean;
  falsePositives: number;
  verified: number;
  rejected: number;
}

const NEAR = 3;

async function score(
  provider: OpenAICompatibleProvider,
  s: IScenario,
  verify: boolean
): Promise<IScore> {
  const dir = setup(s);

  try {
    const report = await reviewChange(provider, dir, { verify });
    const onPlant = (line: number): boolean => Math.abs(line - s.line) <= NEAR;
    const hits = report.findings.filter(
      (f) => f.file === s.file && onPlant(f.line)
    );
    const fp = report.findings.filter(
      (f) => !(f.file === s.file && onPlant(f.line))
    );

    return {
      found: hits.length > 0,
      falsePositives: fp.length,
      verified: report.findings.length,
      rejected: report.rejected,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface IVariantAgg {
  variant: string;
  recall: number;
  avgFalsePositives: number;
  scores: { id: string; score: IScore }[];
}

async function runVariant(
  provider: OpenAICompatibleProvider,
  verify: boolean
): Promise<IVariantAgg> {
  const scores: { id: string; score: IScore }[] = [];

  for (const s of SCENARIOS) {
    const sc = await score(provider, s, verify);

    scores.push({ id: s.id, score: sc });
    process.stdout.write(
      `  [${verify ? "verify=on " : "verify=off"}] ${s.id}: found=${sc.found ? "yes" : "no"} fp=${sc.falsePositives}\n`
    );
  }

  const found = scores.filter((x) => x.score.found).length;
  const fpTotal = scores.reduce((n, x) => n + x.score.falsePositives, 0);

  return {
    variant: verify ? "verify=on" : "verify=off",
    recall: found / scores.length,
    avgFalsePositives: fpTotal / scores.length,
    scores,
  };
}

const provider = await buildProvider();
const { entry } = await resolveActiveModel();

process.stdout.write(`review-eval: model ${entry.model}\n`);

const variants = [
  await runVariant(provider, true),
  await runVariant(provider, false),
];

process.stdout.write("\n=== review-eval summary ===\n");

for (const v of variants) {
  process.stdout.write(
    `${v.variant}: recall ${(v.recall * 100).toFixed(0)}%  avg false-positives ${v.avgFalsePositives.toFixed(2)}\n`
  );
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runsDir = join(import.meta.dir, "..", "..", "..", "evals", "runs");
const out = join(runsDir, `review-eval-${stamp}.json`);

mkdirSync(runsDir, { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ model: entry.model, variants }, null, 2)}\n`
);
process.stdout.write(`\nsaved ${out}\n`);
