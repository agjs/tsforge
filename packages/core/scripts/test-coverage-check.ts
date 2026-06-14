// Gate-runnable TEST-COVERAGE oracle: run the project's tests with lcov coverage
// and fail if line coverage falls below a floor. Proves the tests don't just
// *pass* but actually *exercise* the code — closing the "added code, added no
// test" gap (a test suite can be green and assert almost nothing).
//
// OPT-IN: only wired into the gate when TSFORGE_COVERAGE is set (a percent, e.g.
// `TSFORGE_COVERAGE=80`). Skips cleanly (exit 0) when the project has no tests or
// the coverage report can't be produced — it never blocks a project that simply
// has nothing to measure yet.
//
//   TSFORGE_COVERAGE=80 bun test-coverage-check.ts
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ICoverage {
  readonly lineFound: number; // LF
  readonly lineHit: number; // LH
  readonly funcFound: number; // FNF
  readonly funcHit: number; // FNH
  readonly linePct: number; // 0..100
  readonly funcPct: number; // 0..100
  /** The weaker of line/function coverage — the floor is checked against this so
   *  an uncovered FUNCTION can't hide behind line counts (bun marks a one-line
   *  arrow's declaration line "hit" even when the function is never called). */
  readonly pct: number;
}

function sumPrefixed(text: string, prefix: string): number {
  let total = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith(prefix)) {
      const n = Number(line.slice(prefix.length).trim());

      total += Number.isNaN(n) ? 0 : n;
    }
  }

  return total;
}

/** Sum line (LF/LH) and function (FNF/FNH) coverage across an lcov.info report. */
export function parseLcovCoverage(text: string): ICoverage {
  const lineFound = sumPrefixed(text, "LF:");
  const lineHit = sumPrefixed(text, "LH:");
  const funcFound = sumPrefixed(text, "FNF:");
  const funcHit = sumPrefixed(text, "FNH:");
  const linePct = lineFound === 0 ? 100 : (lineHit / lineFound) * 100;
  const funcPct = funcFound === 0 ? 100 : (funcHit / funcFound) * 100;

  return {
    lineFound,
    lineHit,
    funcFound,
    funcHit,
    linePct,
    funcPct,
    pct: Math.min(linePct, funcPct),
  };
}

/** The configured floor: TSFORGE_COVERAGE as a percent, default 80 when set
 *  truthy-but-not-a-useful-number (e.g. `=1`). */
export function coverageFloor(raw: string | undefined): number {
  if (raw === undefined) {
    return 80;
  }

  const n = Number(raw);

  return Number.isFinite(n) && n > 1 && n <= 100 ? n : 80;
}

async function main(): Promise<number> {
  const floor = coverageFloor(process.env.TSFORGE_COVERAGE);
  const covDir = mkdtempSync(join(tmpdir(), "tsforge-cov-"));

  try {
    const proc = Bun.spawn(
      [
        "bun",
        "test",
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${covDir}`,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }
    );

    await proc.exited;

    const lcovPath = join(covDir, "lcov.info");

    if (!existsSync(lcovPath)) {
      process.stdout.write(
        "test-coverage-check: no lcov report produced (no tests?) — skipping.\n"
      );

      return 0;
    }

    const cov = parseLcovCoverage(readFileSync(lcovPath, "utf8"));

    if (cov.lineFound === 0 && cov.funcFound === 0) {
      process.stdout.write(
        "test-coverage-check: nothing instrumented — skipping.\n"
      );

      return 0;
    }

    const pct = cov.pct.toFixed(1);

    if (cov.pct + 1e-9 < floor) {
      process.stderr.write(
        `test-coverage-check: coverage ${pct}% is below the ${floor}% floor ` +
          `(lines ${cov.lineHit}/${cov.lineFound}, functions ${cov.funcHit}/${cov.funcFound}). ` +
          `Add tests that actually call the uncovered code.\n`
      );

      return 1;
    }

    process.stdout.write(
      `test-coverage-check: ${pct}% >= ${floor}% floor ` +
        `(lines ${cov.lineHit}/${cov.lineFound}, functions ${cov.funcHit}/${cov.funcFound}). OK\n`
    );

    return 0;
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await main());
}
