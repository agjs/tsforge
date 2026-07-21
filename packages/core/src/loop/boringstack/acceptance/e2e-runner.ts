import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { URL } from "node:url";

import type { Exec } from "../exec";
import {
  generateEntitySpec,
  specPath,
  stepTitle,
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

  // Chain spec titles: "create root entity: Company" or "create child entity: Contact with parent linkage"
  if (
    testTitle.includes(`create ${entity.id}`) ||
    testTitle.includes(`create root entity: ${entity.id}`) ||
    testTitle.includes(`create child entity: ${entity.id}`)
  ) {
    return "create";
  }

  return null;
}

/**
 * Determine if a Playwright error is an infrastructure failure (browser launch,
 * connection timeout, executable missing, etc.) rather than a test assertion.
 */
function isInfraError(stderr: string): boolean {
  const infraIndicators = [
    "Executable doesn't exist",
    "ECONNREFUSED",
    "error: Browser launch failed",
    "browserType.launch",
    "Failed to fetch",
  ];

  return infraIndicators.some((indicator) => stderr.includes(indicator));
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
 * Parse Playwright JSON reporter output into IAcceptanceResult[].
 * Returns null if the output is not valid JSON (infra error case).
 */
function parsePlaywrightJSON(
  jsonOut: string,
  entity: IEntityAcceptance
): IAcceptanceResult[] | null {
  if (jsonOut.trim().length === 0) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonOut);
  } catch {
    return null;
  }

  if (!isPlaywrightReport(parsed)) {
    return null;
  }

  const results: IAcceptanceResult[] = [];

  if (parsed.suites !== undefined) {
    for (const suite of parsed.suites) {
      walkSuites(suite, entity, results);
    }
  }

  return results;
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
 * Process a single exec result for entity acceptance testing.
 * Returns: { outcome, shouldRetry } where outcome is the final result or undefined to continue/retry.
 */
function processExecResult(
  result: { code: number; stdout: string; stderr: string },
  entity: IEntityAcceptance,
  requiredSteps: AcceptStep[]
): {
  outcome?: IAcceptanceOutcome;
  shouldRetry: boolean;
} {
  const parseResult = parsePlaywrightJSON(result.stdout, entity);

  if (parseResult !== null) {
    // Honor exit code: nonzero means failure even if JSON parsed
    if (result.code !== 0) {
      // Even with exit code failure, check if it's an infrastructure error
      // by looking at stderr or top-level report errors
      const hasInfraError = isInfraError(result.stderr);

      if (hasInfraError) {
        // Known infra failure pattern — can retry
        return {
          outcome: undefined,
          shouldRetry: true,
        };
      }

      // No infra pattern detected — treat as real test failure
      return {
        outcome: {
          ok: false,
          results: parseResult,
          detail:
            result.stderr !== ""
              ? result.stderr
              : `playwright exited with code ${result.code}`,
        },
        shouldRetry: false,
      };
    }

    return {
      outcome: summarize(parseResult, requiredSteps),
      shouldRetry: false,
    };
  }

  // If Playwright produced no parseable JSON, check if this is an infra error
  const hasInfraError = isInfraError(result.stderr);

  // CRITICAL: distinguish infra errors from real test failures
  // If stderr doesn't match a known infra signature, this is a REAL failure
  if (!hasInfraError) {
    // Real test failure (not infra) — return as failed, not infraError
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

  // Infra error: can retry
  return {
    outcome: undefined,
    shouldRetry: true,
  };
}

/**
 * Process chain test results: validate exit code and per-entity coverage.
 * Returns outcome if complete, undefined if should retry.
 */
function processChainResults(
  result: { code: number; stdout: string; stderr: string },
  spec: IAcceptanceSpec,
  allResults: IAcceptanceResult[]
): IAcceptanceOutcome | undefined {
  // Honor exit code: nonzero means failure even if JSON parsed
  if (result.code !== 0) {
    return {
      ok: false,
      results: allResults,
      detail:
        result.stderr !== ""
          ? result.stderr
          : `playwright exited with code ${result.code}`,
    };
  }

  // For chain, verify per-entity coverage: each entity MUST have a passing create result
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

          const { outcome, shouldRetry } = processExecResult(
            result,
            entity,
            requiredSteps
          );

          if (outcome !== undefined) {
            return outcome;
          }

          lastError = result.stderr;

          // Infra error: retry up to 3 times
          if (!shouldRetry || attempt === 2) {
            break;
          }
        }

        return {
          ok: false,
          results: [],
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
          const allResults: IAcceptanceResult[] = [];

          for (const entity of spec.entities) {
            const parseResult = parsePlaywrightJSON(result.stdout, entity);

            if (parseResult !== null) {
              allResults.push(...parseResult);
            }
          }

          if (allResults.length > 0) {
            const outcome = processChainResults(result, spec, allResults);

            if (outcome !== undefined) {
              return outcome;
            }
          }

          // If Playwright produced no parseable JSON, check if this is an infra error
          const hasInfraError = isInfraError(result.stderr);

          lastError = result.stderr;

          // CRITICAL: distinguish infra errors from real test failures
          if (!hasInfraError) {
            // Real test failure (not infra) — return as failed, not infraError
            return {
              ok: false,
              results: [],
              detail:
                result.stderr !== ""
                  ? result.stderr
                  : "playwright produced no valid JSON output (likely chain test failure)",
            };
          }

          // Infra error: retry up to 3 times
          if (attempt < 2) {
            continue;
          }

          break;
        }

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
