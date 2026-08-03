import type { IRunRecord, IVariantSummary } from "./eval.types";
import { summarize } from "./score";

/** 95% normal quantile — the multiplier for Wilson intervals and the z-test. */
const Z95 = 1.96;

/** A variant summary enriched with a confidence interval and, when a baseline is
 *  given, a significance test of its pass-rate difference from that baseline. */
export interface IVariantReport extends IVariantSummary {
  /** 95% Wilson score interval for the pass rate, as [low, high] in [0, 1]. */
  readonly passRateCI: readonly [number, number];
  /** Comparison vs the baseline variant (absent for the baseline itself or when
   *  no baseline was supplied). */
  readonly vsBaseline?: {
    readonly deltaPassRate: number;
    readonly z: number;
    /** True when |z| > 1.96 (p < 0.05, two-sided). */
    readonly significant: boolean;
  };
}

export interface ISweepReport {
  /** The baseline variant label, or null if none was matched. */
  readonly baseline: string | null;
  readonly variants: readonly IVariantReport[];
}

/** 95% Wilson score interval for `passed` successes out of `n` trials. */
export function wilsonInterval(passed: number, n: number): [number, number] {
  if (n === 0) {
    return [0, 0];
  }

  const phat = passed / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = Z95 * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));

  return [
    Math.max(0, (centre - margin) / denom),
    Math.min(1, (centre + margin) / denom),
  ];
}

/** Pooled two-proportion z-statistic comparing rate1 (x1/n1) to rate2 (x2/n2). */
export function twoProportionZ(
  x1: number,
  n1: number,
  x2: number,
  n2: number
): number {
  if (n1 === 0 || n2 === 0) {
    return 0;
  }

  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));

  if (se === 0) {
    return 0;
  }

  return (x1 / n1 - x2 / n2) / se;
}

function compareToBaseline(
  variant: IVariantSummary,
  baseline: IVariantSummary
): IVariantReport["vsBaseline"] {
  const z = twoProportionZ(
    variant.passed,
    variant.runs,
    baseline.passed,
    baseline.runs
  );

  return {
    deltaPassRate: variant.passRate - baseline.passRate,
    z,
    significant: Math.abs(z) > Z95,
  };
}

/**
 * Aggregate raw run records into a statistical report: per-variant pass rate with
 * a 95% Wilson interval, plus — when `baselineLabel` matches a variant — a
 * two-proportion significance test of every other variant against it.
 */
export function buildSweepReport(
  records: readonly IRunRecord[],
  baselineLabel?: string
): ISweepReport {
  const summaries = summarize([...records]);
  const baseline =
    baselineLabel === undefined
      ? undefined
      : summaries.find((s) => s.label === baselineLabel);

  const variants = summaries.map((summary) => {
    const passRateCI = wilsonInterval(summary.passed, summary.runs);
    const sameAsBaseline = baseline?.label === summary.label;

    if (baseline === undefined || sameAsBaseline) {
      return { ...summary, passRateCI };
    }

    return {
      ...summary,
      passRateCI,
      vsBaseline: compareToBaseline(summary, baseline),
    };
  });

  return { baseline: baseline?.label ?? null, variants };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function baselineCell(report: IVariantReport, baseline: string | null): string {
  if (baseline === null) {
    return "—";
  }

  if (report.label === baseline) {
    return "baseline";
  }

  const v = report.vsBaseline;

  if (v === undefined) {
    return "—";
  }

  const sign = v.deltaPassRate >= 0 ? "+" : "";
  const mark = v.significant ? " *" : "";

  return `${sign}${pct(v.deltaPassRate)} (z=${v.z.toFixed(2)})${mark}`;
}

/** A cost cell: an em dash when NOTHING recorded a figure, not "0". A rendered 0
 *  reads as "this variant was free", which is how a re-rendered pre-cost sweep (or
 *  a variant whose every run errored) would silently become a pass-rate-only
 *  comparison again. */
function cost(value: number): string {
  return value > 0 ? String(Math.round(value)) : "—";
}

/** Render a sweep report as a Markdown table. `*` marks a significant difference
 *  (p < 0.05) from the baseline. */
export function renderSweepReportMarkdown(report: ISweepReport): string {
  // Tokens and cost/change sit next to pass-rate on purpose: without them a
  // variant that passes a little more often while costing several times as much
  // reads as a straight win.
  const header =
    "| Variant | Runs | Pass | 95% CI | Cycles | T2G | Ms | Tok in | Tok out | Tok/change | Quality | LOC | vs baseline |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";

  const rows = report.variants.map((v) => {
    const ci = `${pct(v.passRateCI[0])}–${pct(v.passRateCI[1])}`;
    const t2g = v.avgTurnsToGreen === null ? "—" : v.avgTurnsToGreen.toFixed(1);

    return (
      `| ${v.label} | ${String(v.runs)} | ${pct(v.passRate)} | ${ci} | ` +
      `${v.avgCycles.toFixed(1)} | ${t2g} | ${String(Math.round(v.avgMs))} | ` +
      `${cost(v.avgTokensIn)} | ${cost(v.avgTokensOut)} | ${cost(v.avgCostPerAcceptedChange)} | ` +
      `${v.avgQuality.toFixed(1)} | ${v.avgLoc.toFixed(1)} | ${baselineCell(v, report.baseline)} |`
    );
  });

  return [
    "## A/B sweep report",
    "",
    header,
    ...rows,
    "",
    "`*` = significant at p < 0.05 (two-proportion z-test vs baseline).",
    ...failureSection(report),
  ].join("\n");
}

/** Format a variant's failure-class tally, e.g. "type-error×2, no-progress×1". */
function formatFailureClasses(classes: Record<string, number>): string {
  return Object.entries(classes)
    .sort(([, a], [, b]) => b - a)
    .map(([cls, n]) => `${cls}×${String(n)}`)
    .join(", ");
}

/** A "why failures happened" section — per-variant failure-class breakdown.
 *  Empty (no lines) when every run passed, so a clean sweep stays terse. */
function failureSection(report: ISweepReport): string[] {
  const lines = report.variants
    .filter((v) => Object.keys(v.failureClasses).length > 0)
    .map((v) => `- **${v.label}**: ${formatFailureClasses(v.failureClasses)}`);

  return lines.length === 0 ? [] : ["", "### Failure breakdown", ...lines];
}
