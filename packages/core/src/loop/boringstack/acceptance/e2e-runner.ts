import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { URL } from "node:url";

import type { Exec } from "../exec";
import {
  generateEntitySpec,
  specPath,
  stepTitle,
  chainCreateTitle,
  generateChainSpec,
  chainSpecPath,
  generateAuthHelper,
  authHelperPath,
} from "./e2e-generator";
import type {
  AcceptStep,
  IAcceptanceOutcome,
  IAcceptanceResult,
  IAcceptanceRunner,
  IAcceptanceRunCtx,
  IEntityAcceptance,
  IAcceptanceSpec,
} from "../../acceptance/acceptance.types";
import { summarize } from "../../acceptance/acceptance-outcome";

/**
 * Type guard to validate a Playwright JSON report structure (nested suites format).
 */
interface IPlaywrightSpec {
  title: string;
  ok: boolean;
  tests?: {
    results?: { status?: string; error?: { message?: string } }[];
  }[];
}

interface IPlaywrightSuite {
  title?: string;
  suites?: IPlaywrightSuite[];
  specs?: IPlaywrightSpec[];
}

interface IPlaywrightReportType {
  suites?: IPlaywrightSuite[];
  stats?: Record<string, unknown>;
  errors?: { message?: string }[];
}

function isPlaywrightReport(obj: unknown): obj is IPlaywrightReportType {
  return (
    typeof obj === "object" &&
    obj !== null &&
    ("suites" in obj || "stats" in obj || "errors" in obj)
  );
}

/**
 * Map a Playwright test title to an AcceptStep.
 * Reverse of stepTitle() in the generator.
 * Also recognizes chain spec test titles.
 */
function parseStep(
  testTitle: string,
  entity: IEntityAcceptance
): AcceptStep | null {
  const navTitle = stepTitle("nav", entity.key, entity.id);

  if (testTitle === navTitle) {
    return "nav";
  }

  const listTitle = stepTitle("list", entity.key, entity.id);

  if (testTitle === listTitle) {
    return "list";
  }

  const createTitle = stepTitle("create", entity.key, entity.id);

  if (testTitle === createTitle) {
    return "create";
  }

  const persistTitle = stepTitle("persist", entity.key, entity.id);

  if (testTitle === persistTitle) {
    return "persist";
  }

  const updateTitle = stepTitle("update", entity.key, entity.id);

  if (testTitle === updateTitle) {
    return "update";
  }

  const deleteTitle = stepTitle("delete", entity.key, entity.id);

  if (testTitle === deleteTitle) {
    return "delete";
  }

  if (testTitle.startsWith("negative: ")) {
    return "negative";
  }

  // Chain spec titles: match ALL three kinds (root, child, standalone)
  const rootCreateTitle = chainCreateTitle("root", entity.id);

  if (testTitle === rootCreateTitle) {
    return "create";
  }

  const childCreateTitle = chainCreateTitle("child", entity.id);

  if (testTitle === childCreateTitle) {
    return "create";
  }

  const standaloneCreateTitle = chainCreateTitle("standalone", entity.id);

  if (testTitle === standaloneCreateTitle) {
    return "create";
  }

  return null;
}

/**
 * Determine if a Playwright error is an infrastructure failure (browser launch,
 * connection timeout, executable missing, etc.) rather than a test assertion.
 * Text parameter should combine stderr and extracted report error messages.
 */
function isInfraError(text: string): boolean {
  const infraIndicators = [
    "Executable doesn't exist",
    "ECONNREFUSED",
    "net::ERR_CONNECTION_REFUSED",
    "net::ERR_CONNECTION",
    "error: Browser launch failed",
    "browserType.launch",
  ];

  return infraIndicators.some((indicator) => text.includes(indicator));
}

/**
 * Extract error messages from a pre-parsed Playwright report object.
 * Collects ONLY top-level report.errors[].message (not per-test errors).
 * Per-test assertion errors must NOT drive suite-wide infra classification.
 * Returns empty string if no errors found or report is invalid.
 */
function extractReportErrorText(parsed: IPlaywrightReportType): string {
  const errors: string[] = [];

  // Collect top-level report errors ONLY
  // Global setup/launch failures land here; per-test assertion errors do not.
  if (Array.isArray(parsed.errors)) {
    for (const err of parsed.errors) {
      if ("message" in err && typeof err.message === "string") {
        errors.push(err.message);
      }
    }
  }

  return errors.join("\n");
}

/**
 * Extract the error message from a test result, if present.
 */
function extractErrorMessage(test: {
  results?: { status?: string; error?: { message?: string } }[];
}): string {
  const firstResult = test.results?.[0];

  return firstResult?.error?.message ?? "failed";
}

/**
 * Process a single spec and add it to the results if it matches a known step.
 * Only counts genuinely passed results (status === "passed"); skipped/interrupted are excluded.
 */
function processSpec(
  spec: IPlaywrightSpec,
  entity: IEntityAcceptance,
  results: IAcceptanceResult[]
): void {
  const step = parseStep(spec.title, entity);

  if (step === null) {
    return;
  }

  const errorMsg =
    spec.tests?.[0] !== undefined
      ? extractErrorMessage(spec.tests[0])
      : "failed";

  // Only count tests with status "passed" as true passes; skip skipped/interrupted
  const firstResult = spec.tests?.[0]?.results?.[0];
  const isGenuinePass = firstResult?.status === "passed" && spec.ok;

  results.push({
    entity: entity.key,
    step,
    ok: isGenuinePass,
    detail: isGenuinePass ? "pass" : errorMsg,
  });
}

/**
 * Recursively walk nested Playwright suites to extract specs and their results.
 */
function walkSuites(
  suite: IPlaywrightSuite,
  entity: IEntityAcceptance,
  results: IAcceptanceResult[]
): void {
  if (suite.specs !== undefined) {
    for (const spec of suite.specs) {
      processSpec(spec, entity, results);
    }
  }

  if (suite.suites !== undefined) {
    for (const nestedSuite of suite.suites) {
      walkSuites(nestedSuite, entity, results);
    }
  }
}

/**
 * Parse Playwright JSON reporter output once, returning both the raw parsed report
 * and the extracted results. Used to avoid double-parsing the same stdout.
 * Returns { parsed, results } where parsed is the report object (or null if invalid JSON),
 * and results are the extracted acceptance results (or empty array if unparseable).
 */
function parsePlaywrightOnce(
  jsonOut: string,
  entity: IEntityAcceptance
): { parsed: IPlaywrightReportType | null; results: IAcceptanceResult[] } {
  const results: IAcceptanceResult[] = [];

  if (jsonOut.trim().length === 0) {
    return { parsed: null, results };
  }

  let parsedUnknown: unknown;

  try {
    parsedUnknown = JSON.parse(jsonOut);
  } catch {
    return { parsed: null, results };
  }

  if (!isPlaywrightReport(parsedUnknown)) {
    return { parsed: null, results };
  }

  // Extract per-test results from the parsed report
  if (parsedUnknown.suites !== undefined) {
    for (const suite of parsedUnknown.suites) {
      walkSuites(suite, entity, results);
    }
  }

  return { parsed: parsedUnknown, results };
}

/**
 * Extract the port number from a URL (e.g., "http://localhost:7331" → 7331).
 */
function portFromURL(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.port !== "") {
      return parsed.port;
    }

    return parsed.protocol === "https:" ? "443" : "80";
  } catch {
    return "80";
  }
}

/**
 * Remove generated files from a given directory path if they exist.
 * Safe to call with non-existent paths.
 */
function cleanupFile(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

/**
 * Classify a nonzero exit: determine if it's infrastructure (should retry) or real failure.
 * Examines both stderr and parsed JSON report errors (if present).
 * Whenever parseResult is not null, preserves it in the outcome and derives meaningful detail
 * from the first failing result (the actual assertion text), with fallback to stderr.
 * Returns: { outcome, shouldRetry } where outcome is undefined for retry, or final result for done.
 */
function classifyNonzeroExit(
  result: { code: number; stderr: string },
  parsedReport: IPlaywrightReportType | null,
  parseResult: IAcceptanceResult[]
): {
  outcome?: IAcceptanceOutcome;
  shouldRetry: boolean;
} {
  // Combine stderr with extracted report errors to form the complete error text
  const reportErrorText =
    parsedReport !== null ? extractReportErrorText(parsedReport) : "";

  const combinedErrorText =
    result.stderr + (reportErrorText !== "" ? "\n" + reportErrorText : "");

  if (isInfraError(combinedErrorText)) {
    // Known infra failure pattern — can retry
    return {
      outcome: undefined,
      shouldRetry: true,
    };
  }

  // No infra pattern detected — treat as real failure
  // ALWAYS preserve parseResult (which may be empty array if JSON was invalid)
  if (parseResult.length > 0) {
    // Derive meaningful detail: use the first failing result's detail, or fall back to stderr
    let detail = result.stderr;

    // Find the first failed result to extract its assertion message
    const firstFailure = parseResult.find((r) => !r.ok);

    if (firstFailure && firstFailure.detail !== "failed") {
      detail = firstFailure.detail;
    } else if (detail === "") {
      // Last resort: use exit code message
      detail = `playwright exited with code ${result.code}`;
    }

    return {
      outcome: {
        ok: false,
        results: parseResult,
        detail,
      },
      shouldRetry: false,
    };
  }

  // Truly unparseable JSON + unknown error text stays a REAL failure (not infra)
  return {
    outcome: {
      ok: false,
      results: [],
      detail:
        result.stderr !== ""
          ? result.stderr
          : "playwright produced no valid JSON output (likely test assertion failure)",
    },
    shouldRetry: false,
  };
}

/**
 * Process a single exec result for entity acceptance testing.
 * Parses Playwright JSON once and threads both the parsed object and results
 * to avoid re-parsing the same stdout.
 * Returns: { outcome, shouldRetry } where outcome is the final result or undefined to continue/retry.
 */
export function processExecResult(
  result: { code: number; stdout: string; stderr: string },
  entity: IEntityAcceptance,
  requiredSteps: AcceptStep[]
): {
  outcome?: IAcceptanceOutcome;
  shouldRetry: boolean;
  parseResult: IAcceptanceResult[];
} {
  // Parse ONCE: extract both the raw parsed report and the acceptance results.
  // Thread both through to avoid re-parsing the same stdout.
  const { parsed: parsedReport, results: parseResult } = parsePlaywrightOnce(
    result.stdout,
    entity
  );

  if (result.code === 0) {
    return {
      outcome: summarize(parseResult, requiredSteps),
      shouldRetry: false,
      parseResult,
    };
  }

  // Nonzero exit code: classify as infra or real failure
  // Pass parsed report and results separately to avoid re-parsing
  return {
    ...classifyNonzeroExit(result, parsedReport, parseResult),
    parseResult,
  };
}

/**
 * Process chain test results: validate exit code and per-entity coverage.
 * Returns outcome if complete, undefined if should retry (infra error).
 */
function processChainResults(
  result: { code: number; stdout: string; stderr: string },
  spec: IAcceptanceSpec,
  allResults: IAcceptanceResult[]
): IAcceptanceOutcome | undefined {
  // Honor exit code: nonzero means failure
  if (result.code !== 0) {
    // Parse once to get the report object for error extraction (chain tests don't use per-test results)
    // Use first entity as representative; we only need the parsed report structure, not entity-specific results
    const firstEntity = spec.entities[0];

    let parsedReport: IPlaywrightReportType | null = null;

    if (firstEntity) {
      const { parsed } = parsePlaywrightOnce(result.stdout, firstEntity);

      parsedReport = parsed;
    }

    // Check if this is an infrastructure error; pass allResults for preservation
    const { outcome, shouldRetry } = classifyNonzeroExit(
      result,
      parsedReport,
      allResults
    );

    if (shouldRetry) {
      // Infra error: signal retry via undefined
      return undefined;
    }

    // Real failure: return the outcome from classify
    if (outcome !== undefined) {
      return outcome;
    }

    // Unreachable: classify always returns an outcome when shouldRetry is false
    return {
      ok: false,
      results: allResults,
      detail: `playwright exited with code ${result.code}`,
    };
  }

  // Exit code 0: verify per-entity coverage
  // Each entity MUST have a passing create result
  const entityKeysWithCreate = new Set(
    allResults.filter((r) => r.step === "create" && r.ok).map((r) => r.entity)
  );

  const requiredEntityKeys = new Set(spec.entities.map((e) => e.key));

  // Check if all entities have a passing create
  for (const key of requiredEntityKeys) {
    if (!entityKeysWithCreate.has(key)) {
      return {
        ok: false,
        results: allResults,
        detail: `acceptance incomplete: entity '${key}' missing create step`,
      };
    }
  }

  // All entities have passing creates, summarize the full results
  return summarize(allResults);
}

/**
 * Create an IAcceptanceRunner for BoringStack.
 *
 * Writes the entity spec to disk, invokes Playwright via exec, parses the JSON
 * reporter output, and classifies infrastructure errors vs. test failures.
 * Retries (max 2) on infra failures only.
 */
export function makeBoringstackAcceptanceRunner(exec: Exec): IAcceptanceRunner {
  return {
    async run(
      entity: IEntityAcceptance,
      ctx: IAcceptanceRunCtx,
      spec?: IAcceptanceSpec
    ): Promise<IAcceptanceOutcome> {
      const specFilePath = specPath(ctx.cwd, entity.key);
      const authPath = authHelperPath(ctx.cwd);

      try {
        // Write auth helper unconditionally (idempotent overwrite for every run)
        const authHelperCode = generateAuthHelper();

        mkdirSync(dirname(authPath), { recursive: true });
        writeFileSync(authPath, authHelperCode, "utf-8");

        const generatedSpec = generateEntitySpec(entity, spec);

        mkdirSync(dirname(specFilePath), { recursive: true });
        writeFileSync(specFilePath, generatedSpec, "utf-8");

        // Require these steps for a single entity run
        const requiredSteps: AcceptStep[] = [
          "nav",
          "list",
          "create",
          "persist",
          "update",
          "delete",
        ];

        if (entity.negatives.length > 0) {
          requiredSteps.push("negative");
        }

        let lastError: string | undefined;
        let lastResults: IAcceptanceResult[] = [];

        for (let attempt = 0; attempt < 3; attempt++) {
          const uiPort = portFromURL(ctx.uiBase);
          const env = {
            ...process.env,
            PLAYWRIGHT_PORT: uiPort,
            VITE_API_BASE: ctx.apiBase,
          };

          const result = await exec(
            [
              "bunx",
              "playwright",
              "test",
              `_acceptance/${entity.key}.spec.ts`,
              "--reporter=json",
              "--project=chromium",
            ],
            {
              cwd: `${ctx.cwd}/apps/ui`,
              env,
            }
          );

          const { outcome, shouldRetry, parseResult } = processExecResult(
            result,
            entity,
            requiredSteps
          );

          if (outcome !== undefined) {
            return outcome;
          }

          // Preserve parsed results even if classified as infra (for diagnostics).
          // Reuse the parse from processExecResult — do not re-parse the same stdout.
          // parseResult is always an array (may be empty if JSON was invalid)
          lastResults = parseResult;

          lastError = result.stderr;

          // Infra error: retry up to 3 times
          if (!shouldRetry || attempt === 2) {
            break;
          }
        }

        return {
          ok: false,
          results: lastResults,
          infraError:
            lastError !== "" ? lastError : "playwright execution failed",
        };
      } finally {
        // Clean up generated spec and auth helper so they don't persist
        // into the next fast-gate cycle and get flagged as unused by knip.
        cleanupFile(specFilePath);
        cleanupFile(authPath);
      }
    },

    async runChain(
      spec: IAcceptanceSpec,
      ctx: IAcceptanceRunCtx
    ): Promise<IAcceptanceOutcome> {
      const authPath = authHelperPath(ctx.cwd);
      const chainPath = chainSpecPath(ctx.cwd);

      try {
        // Write auth helper unconditionally (idempotent overwrite for every run)
        const authHelperCode = generateAuthHelper();

        mkdirSync(dirname(authPath), { recursive: true });
        writeFileSync(authPath, authHelperCode, "utf-8");

        const chainSpec = generateChainSpec(spec);

        mkdirSync(dirname(chainPath), { recursive: true });
        writeFileSync(chainPath, chainSpec, "utf-8");

        let lastError: string | undefined;

        for (let attempt = 0; attempt < 3; attempt++) {
          const uiPort = portFromURL(ctx.uiBase);
          const env = {
            ...process.env,
            PLAYWRIGHT_PORT: uiPort,
            VITE_API_BASE: ctx.apiBase,
          };

          const result = await exec(
            [
              "bunx",
              "playwright",
              "test",
              "_acceptance/chain.spec.ts",
              "--reporter=json",
              "--project=chromium",
            ],
            {
              cwd: `${ctx.cwd}/apps/ui`,
              env,
            }
          );

          // For chain specs, collect results from all entities
          // Parse once: reuse the parsed report for all entity result extraction
          const allResults: IAcceptanceResult[] = [];

          for (const entity of spec.entities) {
            const { results: parseResult } = parsePlaywrightOnce(
              result.stdout,
              entity
            );

            if (parseResult.length > 0) {
              allResults.push(...parseResult);
            }
          }

          // Process results: returns outcome (final result) or undefined (should retry on infra)
          const outcome = processChainResults(result, spec, allResults);

          if (outcome !== undefined) {
            return outcome;
          }

          // Infra error signaled via undefined — will retry
          lastError = result.stderr;

          if (attempt === 2) {
            // Max attempts reached on infra error
            break;
          }
        }

        // Exhausted retries on infra error
        return {
          ok: false,
          results: [],
          infraError:
            lastError !== "" ? lastError : "playwright chain execution failed",
        };
      } finally {
        // Clean up generated chain spec and auth helper so they don't persist
        // into the next fast-gate cycle and get flagged as unused by knip.
        cleanupFile(chainPath);
        cleanupFile(authPath);
      }
    },
  };
}
