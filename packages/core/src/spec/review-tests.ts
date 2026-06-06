import { join } from "node:path";
import type { IProvider } from "../inference";
import type { Reporter } from "../loop";
import { isRecord, isArray } from "../lib/guards";
import { extractJson } from "../lib/json";
import { runTests, isRealRed } from "../validate/run-tests";
import { FINDING_KIND } from "./spec.constants";
import type {
  FindingKind,
  ITestFinding,
  IReviewResult,
  IReviewInput,
  IReviewFixOptions,
  IReviewFixResult,
} from "./spec.types";

const FINDING_KINDS = new Set<string>(Object.values(FINDING_KIND));

/**
 * Offline teacher review of a generated suite: the `runTests` oracle proves a
 * suite is real/runnable/RED, but NOT that its assertions are CORRECT. A live
 * run found two ways a model's tests go wrong — assertions that are
 * *unsatisfiable* given runtime reality (e.g. `1.005 * 100 === 100.4999…` under
 * IEEE-754) and *ambiguity-overreach* (asserting one arbitrary resolution of a
 * tie the criteria leave open). This vets for both, plus *over-strict* (testing
 * behaviour the criteria never required).
 *
 * Point `provider` at a flagship — this is an OFFLINE teacher step, never a
 * runtime dependency. It returns findings plus a corrected suite; the CALLER
 * must re-run the RED oracle on `correctedSuite` (a fix must stay real + RED)
 * before trusting it.
 */
const SYSTEM = [
  "You are a senior TypeScript test reviewer. You are given acceptance criteria and a generated `bun:test` suite, and you find assertions that would block a CORRECT implementation.",
  "Flag three kinds: (1) `unsatisfiable` — no correct implementation can pass it given JS/TS runtime reality (e.g. IEEE-754: `1.005 * 100` is `100.4999…`, so cents can't recover `101` from the number `1.005`); (2) `over-strict` — it asserts behaviour the criteria never required; (3) `ambiguous` — the criteria under-specify and the test asserts one arbitrary resolution (e.g. which index gets the leftover penny on a tie).",
  'Respond with ONLY JSON: {"findings":[{"test":"<name>","kind":"unsatisfiable|over-strict|ambiguous|ok","reason":"<short>"}],"correctedSuite":"<full corrected test file, or empty string if nothing needs changing>"}.',
  "When correcting: fix or remove ONLY the flawed assertions — keep all the sound coverage, keep the same imports, and do not weaken the suite otherwise.",
].join("\n");

export async function reviewTests(
  provider: IProvider,
  input: IReviewInput
): Promise<IReviewResult> {
  const res = await provider.complete(
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Goal: ${input.goal}\n\nAcceptance criteria:\n${input.criteria}\n\nThe suite imports the implementation from "${input.moduleSpecifier}".\n\nGenerated suite:\n${input.testCode}`,
      },
    ],
    { temperature: 0 }
  );

  const empty: IReviewResult = { findings: [], correctedSuite: "" };

  let data: unknown;

  try {
    data = JSON.parse(extractJson(res.content));
  } catch {
    return empty;
  }

  if (!isRecord(data)) {
    return empty;
  }

  return {
    findings: parseFindings(data.findings),
    correctedSuite:
      typeof data.correctedSuite === "string" ? data.correctedSuite : "",
  };
}

function parseFindings(raw: unknown): ITestFinding[] {
  if (!isArray(raw)) {
    return [];
  }

  const findings: ITestFinding[] = [];

  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }

    const { test, kind, reason } = entry;

    if (typeof test === "string" && isFindingKind(kind)) {
      findings.push({
        test,
        kind,
        reason: typeof reason === "string" ? reason : "",
      });
    }
  }

  return findings;
}

function isFindingKind(value: unknown): value is FindingKind {
  return typeof value === "string" && FINDING_KINDS.has(value);
}

/**
 * Run the offline review against the suite on disk and apply a correction —
 * but only if it survives the SAME RED oracle the suite originally passed. A
 * proposed fix that breaks loadability or goes vacuous is reverted, so review
 * can never hand the implement loop anything less sound than what it got.
 */
export async function reviewAndFixSuite(
  provider: IProvider,
  cwd: string,
  opts: IReviewFixOptions
): Promise<IReviewFixResult> {
  const report: Reporter = opts.onEvent ?? (() => undefined);
  const testPath = join(cwd, opts.testFile);
  const original = await Bun.file(testPath).text();

  const review = await reviewTests(provider, {
    goal: opts.goal,
    criteria: opts.criteria,
    testCode: original,
    moduleSpecifier: `./${opts.implFile.replace(/\.ts$/, "")}`,
  });

  for (const f of review.findings) {
    report({
      kind: "fix",
      task: opts.testFile,
      message: `review: ${f.kind} — ${f.test}: ${f.reason}`,
    });
  }

  if (review.correctedSuite.length === 0) {
    return { findings: review.findings, applied: false };
  }

  await Bun.write(testPath, review.correctedSuite);

  const run = await runTests(opts.testFile, cwd);

  if (!isRealRed(run)) {
    await Bun.write(testPath, original);
    report({
      kind: "fix",
      task: opts.testFile,
      message: `review correction broke the RED guarantee (${run.pass} pass / ${run.errors} err) — reverted`,
    });

    return { findings: review.findings, applied: false };
  }

  report({
    kind: "fix",
    task: opts.testFile,
    message: `review correction applied — ${run.total} tests, still RED`,
  });

  return { findings: review.findings, applied: true };
}
