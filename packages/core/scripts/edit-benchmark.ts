// Compare edit mechanisms (edit vs edit_lines) across completed run artifacts.
// Parses run.log + result.json from sweep runs to measure: tool calls, success rates,
// stale-anchor recovery, token cost (args size), gate failures, turns to green.
//
// Run:  bun run packages/core/scripts/edit-benchmark.ts <dir> <dir> ...
//   (analyze run dirs produced with hashline on vs off)
// Or:   bun run packages/core/scripts/edit-benchmark.ts --json <output.json> <dir> <dir> ...
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord } from "../src/lib/guards";

interface IEditMetrics {
  runId: string;
  hashlineEnabled: boolean;
  editToolCalls: number;
  editLinesToolCalls: number;
  editRejections: number;
  editLinesRejections: number;
  staleAnchorRecoveries: number;
  /** Mean tool-args bytes per successful edit (token-cost proxy). */
  meanToolArgBytes: number;
  gateFails: number;
  /** Turns from start to first GREEN gate result. */
  turnsToGreen: number;
  totalTurns: number;
  passed: boolean;
  quality?: number;
}

interface IEditSummary {
  label: string;
  runs: number;
  avgEditToolCalls: number;
  avgEditLinesToolCalls: number;
  editSuccessRate: number;
  editLinesSuccessRate: number;
  avgStaleAnchorRecoveries: number;
  avgMeanToolArgBytes: number;
  avgGateFails: number;
  avgTurnsToGreen: number;
  passRate: number;
  avgQuality: number;
}

function countPattern(lines: string[], pattern: RegExp): number {
  return lines.filter((line) => pattern.test(line)).length;
}

async function parseRunLog(
  logPath: string
): Promise<Omit<IEditMetrics, "runId" | "hashlineEnabled">> {
  const logText = await readFile(logPath, "utf-8");
  const lines = logText.split("\n");

  const editToolCalls = countPattern(lines, /✎ edit .*/);
  const editLinesToolCalls = countPattern(lines, /edit_lines /);
  const editRejections = countPattern(lines, /edit .*REJECTED/);
  const editLinesRejections = countPattern(lines, /edit_lines .*REJECTED/);
  const staleAnchorRecoveries = countPattern(
    lines,
    /snapshot.*merge|anchor.*stale|recovery.*suggest/
  );
  const successfulEdits = countPattern(
    lines,
    /edited .*\(new hash #|✎ edit .* \)$/
  );
  const gateFails = countPattern(lines, /turn \d+: red \(\d+ error/);
  const isGreen = lines.some((line) => /spec ".*": done/.test(line));

  // Calculate total args bytes from successful edits
  const successLines = lines.filter((line) =>
    /edited .*\(new hash #|✎ edit .* \)$/.test(line)
  );
  const totalArgBytes = successLines.reduce(
    (sum, line) => sum + line.length,
    0
  );

  // Find turn counts
  let totalTurns = 0;
  let turnsToGreen = -1;

  for (const line of lines) {
    const askMatch = /turn (\d+): asking model/.exec(line);

    if (askMatch !== null) {
      totalTurns = Math.max(totalTurns, Number(askMatch[1]));
    }

    if (/· turn \d+: GREEN/.test(line) && turnsToGreen < 0) {
      turnsToGreen = totalTurns;
    }
  }

  return {
    editToolCalls,
    editLinesToolCalls,
    editRejections,
    editLinesRejections,
    staleAnchorRecoveries,
    meanToolArgBytes:
      successfulEdits > 0 ? Math.round(totalArgBytes / successfulEdits) : 0,
    gateFails,
    turnsToGreen: turnsToGreen >= 0 ? turnsToGreen : totalTurns,
    totalTurns,
    passed: isGreen,
  };
}

async function parseResultJson(
  jsonPath: string
): Promise<{ quality?: number; hashlineEnabled: boolean }> {
  try {
    const text = await readFile(jsonPath, "utf-8");
    const parsed: unknown = JSON.parse(text);

    if (!isRecord(parsed)) {
      return { hashlineEnabled: false };
    }

    const quality =
      typeof parsed.quality === "number" ? parsed.quality : undefined;
    const features = isRecord(parsed.features) ? parsed.features : {};

    return {
      quality,
      hashlineEnabled:
        features.TSFORGE_HASHLINE === "1" ||
        process.env.TSFORGE_HASHLINE === "1",
    };
  } catch {
    return { hashlineEnabled: false };
  }
}

async function analyzeRunDir(dir: string): Promise<IEditMetrics | null> {
  const logPath = join(dir, "run.log");
  const jsonPath = join(dir, "result.json");
  const runId = basename(dir);

  try {
    const logMetrics = await parseRunLog(logPath);
    const jsonData = await parseResultJson(jsonPath);

    return {
      runId,
      hashlineEnabled: jsonData.hashlineEnabled,
      ...logMetrics,
      quality: jsonData.quality,
    };
  } catch {
    return null;
  }
}

function summarizeMetrics(metrics: IEditMetrics[]): IEditSummary {
  const m0 = metrics[0];
  const label =
    m0 !== undefined
      ? m0.hashlineEnabled
        ? "hashline=on"
        : "hashline=off"
      : "unknown";

  const passed = metrics.filter((m) => m.passed).length;
  const scored = metrics.filter((m) => m.quality !== undefined);

  const sum = (sel: (m: IEditMetrics) => number): number =>
    metrics.reduce((a, m) => a + sel(m), 0);
  const avg = (sel: (m: IEditMetrics) => number): number =>
    metrics.length > 0 ? sum(sel) / metrics.length : 0;

  const totalEditCalls = sum((m) => m.editToolCalls);
  const totalEditLines = sum((m) => m.editLinesToolCalls);

  return {
    label,
    runs: metrics.length,
    avgEditToolCalls: avg((m) => m.editToolCalls),
    avgEditLinesToolCalls: avg((m) => m.editLinesToolCalls),
    editSuccessRate:
      totalEditCalls > 0
        ? 1 - sum((m) => m.editRejections) / totalEditCalls
        : 1,
    editLinesSuccessRate:
      totalEditLines > 0
        ? 1 - sum((m) => m.editLinesRejections) / totalEditLines
        : 1,
    avgStaleAnchorRecoveries: avg((m) => m.staleAnchorRecoveries),
    avgMeanToolArgBytes: avg((m) => m.meanToolArgBytes),
    avgGateFails: avg((m) => m.gateFails),
    avgTurnsToGreen: avg((m) => m.turnsToGreen),
    passRate: metrics.length > 0 ? passed / metrics.length : 0,
    avgQuality:
      scored.length > 0
        ? scored.reduce((a, m) => a + (m.quality ?? 0), 0) / scored.length
        : 0,
  };
}

function renderSummaryTable(summaries: IEditSummary[]): string {
  const headers = [
    "condition",
    "runs",
    "edit calls",
    "edit_lines calls",
    "edit % success",
    "edit_lines % success",
    "stale recovery",
    "mean args (bytes)",
    "gate fails",
    "turns to green",
    "pass rate",
    "avg quality",
  ];

  const rows = summaries.map((s) => [
    s.label,
    String(s.runs),
    s.avgEditToolCalls.toFixed(1),
    s.avgEditLinesToolCalls.toFixed(1),
    (s.editSuccessRate * 100).toFixed(0),
    (s.editLinesSuccessRate * 100).toFixed(0),
    s.avgStaleAnchorRecoveries.toFixed(2),
    String(Math.round(s.avgMeanToolArgBytes)),
    s.avgGateFails.toFixed(1),
    s.avgTurnsToGreen.toFixed(1),
    (s.passRate * 100).toFixed(0),
    s.avgQuality.toFixed(1),
  ]);

  // Simple ASCII table
  const colWidths = headers.map((h, i) => {
    return Math.max(
      h.length,
      ...rows.map((r) => {
        const cell = r[i];

        return cell !== undefined ? cell.length : 0;
      })
    );
  });

  const headerLine = headers
    .map((h, i) => h.padEnd(colWidths[i] ?? 0))
    .join(" | ");
  const separator = colWidths.map((w) => "-".repeat(w)).join("-+-");
  const dataLines = rows
    .map((r) => r.map((c, i) => c.padEnd(colWidths[i] ?? 0)).join(" | "))
    .join("\n");

  return `${headerLine}\n${separator}\n${dataLines}`;
}

const args = process.argv.slice(2);
const jsonOutput = args[0] === "--json" ? args[1] : undefined;
const dirs = jsonOutput !== undefined ? args.slice(2) : args;

if (dirs.length === 0) {
  process.stdout.write(
    "Usage: edit-benchmark [--json <output.json>] <dir> [<dir> ...]\n"
  );
  process.exit(1);
}

const allMetrics: IEditMetrics[] = [];

for (const dir of dirs) {
  const metrics = await analyzeRunDir(dir);

  if (metrics !== null) {
    allMetrics.push(metrics);
  }
}

// Group by hashline on/off
const byHashline = new Map<boolean, IEditMetrics[]>();

for (const m of allMetrics) {
  const list = byHashline.get(m.hashlineEnabled) ?? [];

  list.push(m);
  byHashline.set(m.hashlineEnabled, list);
}

const summaries: IEditSummary[] = [];

for (const [, metrics] of byHashline) {
  summaries.push(summarizeMetrics(metrics));
}

summaries.sort((a, b) => a.label.localeCompare(b.label));

const table = renderSummaryTable(summaries);

process.stdout.write("\n=== edit-benchmark comparison ===\n\n");
process.stdout.write(table);
process.stdout.write("\n");

if (jsonOutput !== undefined) {
  await Bun.write(
    jsonOutput,
    JSON.stringify(
      {
        analyzed: allMetrics.length,
        summaries,
        table,
      },
      null,
      2
    )
  );
  process.stdout.write(`\nsaved JSON report to ${jsonOutput}\n`);
}
