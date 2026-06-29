// Extract luck-INDEPENDENT mechanism signals from eval run logs, so harness
// changes can be judged by what they actually did — not by a single noisy
// turn-count. Reads each run dir's plain-text run.log (+ result.json) and
// tabulates, then summarizes the spread across runs.
//
// Run:  bun run packages/core/scripts/analyze-runs.ts money 5
//   (analyze the latest 5 `money-*` run dirs)
// Or:   bun run packages/core/scripts/analyze-runs.ts <dir> <dir> ...
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards";

const evalsRoot = join(import.meta.dir, "..", "..", "..", "evals");
// Sweep writes each run to evals/runs/<runId> (see sweep.ts). Run dirs are
// resolved from there, not the evals/ root (which only holds runs/, corpus/, …).
const runsRoot = join(evalsRoot, "runs");

interface IRunMetrics {
  runId: string;
  passed: boolean;
  turns: number;
  totalSeconds: number;
  /** Highest per-turn gate error count seen — >1 proves the combined parser
   *  surfaced structured, per-error feedback (not one opaque blob). */
  maxErrorsSurfaced: number;
  /** Times the model enumerated source lines by hand to locate an error —
   *  should be 0 since gate feedback shows the offending line. */
  handCountingLines: number;
  /** Most file mutations applied in a SINGLE turn — >1 means it fixed several
   *  sites at once instead of one-per-turn. */
  maxEditsPerTurn: number;
  totalEdits: number;
  /** Longest single turn (s) — usually one heavy reasoning turn; shows that
   *  wall-time variance is the model thinking, not harness churn. */
  slowestTurnSeconds: number;
  /** Char volume of the heaviest turn (reasoning+content). Shows whether a
   *  thinking_token_budget binds (drops it) and flags spirals (huge value). */
  maxTurnChars: number;
  /** Tool calls the harness rejected (bad input / scope / match failure) — the
   *  open-model tool-calling friction; 0 = clean. Repaired calls excluded. */
  toolRejects: number;
  regressions: number;
  quality: number | undefined;
}

// The turn-timing line (turn.ts reportTurnTiming). The `⏱` prefix was dropped
// from the emitter, so it's optional here to stay compatible with both formats.
const TIMING =
  /(?:⏱ )?turn (\d+) took ([\d.]+)(s|ms) \(total ([\d.]+)(s|ms)\)/u;
const RED = /turn \d+: red \((\d+) error/;
const ASKING = /turn (\d+): asking model/;
// Hand-counting = the model re-typing the file with SEQUENTIAL line numbers
// (`1: …`, `2: …`) to LOCATE an error it can't see — the costly pattern the
// located-feedback fix removes. Deliberately excludes `Line 37:`-style citations
// of feedback-provided lines, which are the model USING the located errors.
const HAND_COUNT = /^\s*\d+:\s+(?:export|const|function|return|if|for|\}|\/\/)/;

interface ITurnTiming {
  turn: number;
  tookSeconds: number | null;
  totalSeconds: number | null;
}

/** Parse a `turn N took Xs (total Ys)` line into its seconds (ms normalized). */
function parseTiming(line: string): ITurnTiming | null {
  const m = TIMING.exec(line);

  if (m?.[1] === undefined) {
    return null;
  }

  const took =
    m[2] === undefined
      ? null
      : m[3] === "ms"
        ? Number(m[2]) / 1000
        : Number(m[2]);
  const total =
    m[4] === undefined
      ? null
      : m[5] === "ms"
        ? Number(m[4]) / 1000
        : Number(m[4]);

  return { turn: Number(m[1]), tookSeconds: took, totalSeconds: total };
}

function parseLog(
  runId: string,
  log: string
): Omit<IRunMetrics, "regressions" | "quality"> {
  const lines = log.split("\n");

  let turns = 0;
  let totalSeconds = 0;
  let slowestTurnSeconds = 0;
  let maxErrorsSurfaced = 0;
  let handCountingLines = 0;
  let totalEdits = 0;
  let maxEditsPerTurn = 0;
  let editsThisTurn = 0;
  let charsThisTurn = 0;
  let maxTurnChars = 0;
  let toolRejects = 0;
  const passed = /spec ".*": done/.test(log) || /· turn \d+: GREEN/.test(log);

  for (const line of lines) {
    const asking = ASKING.exec(line);

    if (asking !== null) {
      maxEditsPerTurn = Math.max(maxEditsPerTurn, editsThisTurn);
      editsThisTurn = 0;
      charsThisTurn = 0;
    }

    // Reasoning+content volume of the turn — how "does a thinking_token_budget
    // bind?" shows up here (and a spiral is a huge maxTurnChars).
    charsThisTurn += line.length;

    if (line.includes("✎ edit") || line.includes("✚ create")) {
      totalEdits += 1;
      editsThisTurn += 1;
    }

    const timing = parseTiming(line);

    if (timing !== null) {
      turns = Math.max(turns, timing.turn);
      maxTurnChars = Math.max(maxTurnChars, charsThisTurn);

      if (timing.tookSeconds !== null) {
        slowestTurnSeconds = Math.max(slowestTurnSeconds, timing.tookSeconds);
      }

      if (timing.totalSeconds !== null) {
        totalSeconds = timing.totalSeconds;
      }
    }

    const red = RED.exec(line);

    if (red?.[1] !== undefined) {
      maxErrorsSurfaced = Math.max(maxErrorsSurfaced, Number(red[1]));
    }

    if (HAND_COUNT.test(line)) {
      handCountingLines += 1;
    }

    if (/tool_input_rejected:|tool_rejected:/.test(line)) {
      toolRejects += 1;
    }
  }

  maxEditsPerTurn = Math.max(maxEditsPerTurn, editsThisTurn);

  return {
    runId,
    passed,
    turns,
    totalSeconds,
    maxErrorsSurfaced,
    handCountingLines,
    maxEditsPerTurn,
    totalEdits,
    slowestTurnSeconds,
    maxTurnChars,
    toolRejects,
  };
}

async function readResult(
  dir: string
): Promise<{ regressions: number; quality: number | undefined }> {
  const file = Bun.file(join(dir, "result.json"));

  if (!(await file.exists())) {
    return { regressions: 0, quality: undefined };
  }

  const data: unknown = JSON.parse(await file.text());

  if (!isRecord(data)) {
    return { regressions: 0, quality: undefined };
  }

  const quality = typeof data.quality === "number" ? data.quality : undefined;
  let regressions = 0;

  if (Array.isArray(data.tasks)) {
    for (const t of data.tasks) {
      if (isRecord(t) && typeof t.regressions === "number") {
        regressions += t.regressions;
      }
    }
  }

  return { regressions, quality };
}

async function resolveDirs(): Promise<string[]> {
  const args = process.argv.slice(2);

  // `<seed> <count>` form: latest N run dirs whose name starts with the seed.
  if (args.length === 2 && /^\d+$/.test(args[1] ?? "")) {
    const prefix = args[0] ?? "";
    const count = Number(args[1]);
    // evals/runs/ may not exist yet on a clean checkout (no sweep has run) —
    // treat that as "no runs" instead of crashing with ENOENT.
    const all = await readdir(runsRoot, { withFileTypes: true }).catch(
      () => []
    );
    const dirs = all
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .map((d) => d.name)
      .sort();

    return dirs.slice(-count).map((name) => join(runsRoot, name));
  }

  return args.map((a) => (a.startsWith("/") ? a : join(runsRoot, a)));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length === 0) {
    return 0;
  }

  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

const dirs = await resolveDirs();
const metrics: IRunMetrics[] = [];

for (const dir of dirs) {
  const log = Bun.file(join(dir, "run.log"));

  if (!(await log.exists())) {
    continue;
  }

  const runId = dir.split("/").slice(-1)[0] ?? dir;
  const base = parseLog(runId, await log.text());
  const extra = await readResult(dir);

  metrics.push({ ...base, ...extra });
}

process.stdout.write(`\n=== run analysis (${metrics.length} runs) ===\n\n`);
process.stdout.write(
  "pass  turns  time(s)  slowTurn(s)  maxTurnChars  maxErr  handCount  toolRej  maxEdits/turn  edits  regress  Q\n"
);

for (const m of metrics) {
  process.stdout.write(
    [
      m.passed ? " ✓  " : " ✗  ",
      String(m.turns).padStart(5),
      m.totalSeconds.toFixed(0).padStart(8),
      m.slowestTurnSeconds.toFixed(0).padStart(12),
      String(m.maxTurnChars).padStart(13),
      String(m.maxErrorsSurfaced).padStart(7),
      String(m.handCountingLines).padStart(10),
      String(m.toolRejects).padStart(8),
      String(m.maxEditsPerTurn).padStart(14),
      String(m.totalEdits).padStart(7),
      String(m.regressions).padStart(8),
      (m.quality === undefined ? "-" : String(m.quality)).padStart(3),
      `  ${m.runId}`,
    ].join("") + "\n"
  );
}

const turns = metrics.map((m) => m.turns);
const times = metrics.map((m) => m.totalSeconds);
const passRate = metrics.filter((m) => m.passed).length;

process.stdout.write(
  `\nturns:  min ${Math.min(...turns)}  median ${median(turns)}  max ${Math.max(...turns)}  (spread ${Math.max(...turns) - Math.min(...turns)})\n`
);
process.stdout.write(
  `time:   min ${Math.min(...times).toFixed(0)}s  median ${median(times).toFixed(0)}s  max ${Math.max(...times).toFixed(0)}s\n`
);
process.stdout.write(`pass:   ${passRate}/${metrics.length}\n`);
