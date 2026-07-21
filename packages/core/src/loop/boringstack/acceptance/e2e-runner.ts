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

  results.push({
    entity: entity.key,
    step,
    ok: spec.ok,
    detail: spec.ok ? "pass" : errorMsg,
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
 * Create an IAcceptanceRunner for BoringStack.
 *
 * Writes the entity spec to disk, invokes Playwright via exec, parses the JSON
 * reporter output, and classifies infrastructure errors vs. test failures.
 * Retries (max 2) on infra failures only.
 */
export function makeBoringstackAcceptanceRunner(exec: Exec): IAcceptanceRunner {
  let authHelperWritten = false;

  return {
    async run(
      entity: IEntityAcceptance,
      ctx: IAcceptanceRunCtx
    ): Promise<IAcceptanceOutcome> {
      const specFilePath = specPath(ctx.cwd, entity.key);
      const authPath = authHelperPath(ctx.cwd);

      try {
        // Write auth helper once (shared by all specs)
        if (!authHelperWritten) {
          const authHelperCode = generateAuthHelper();

          mkdirSync(dirname(authPath), { recursive: true });
          writeFileSync(authPath, authHelperCode, "utf-8");
          authHelperWritten = true;
        }

        const spec = generateEntitySpec(entity);

        mkdirSync(dirname(specFilePath), { recursive: true });
        writeFileSync(specFilePath, spec, "utf-8");

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
            ],
            {
              cwd: `${ctx.cwd}/apps/ui`,
              env,
            }
          );

          const parseResult = parsePlaywrightJSON(result.stdout, entity);

          if (parseResult !== null) {
            return summarize(parseResult);
          }

          lastError = result.stderr;
          const hasInfraError = isInfraError(result.stderr);

          if (!hasInfraError || attempt === 2) {
            break;
          }
        }

        return {
          ok: false,
          results: [],
          infraError: lastError ?? "playwright execution failed",
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
        // Write auth helper (may have been written by run(), but ensure it exists)
        if (!authHelperWritten) {
          const authHelperCode = generateAuthHelper();

          mkdirSync(dirname(authPath), { recursive: true });
          writeFileSync(authPath, authHelperCode, "utf-8");
          authHelperWritten = true;
        }

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
            return summarize(allResults);
          }

          lastError = result.stderr;
          const hasInfraError = isInfraError(result.stderr);

          if (!hasInfraError || attempt === 2) {
            break;
          }
        }

        return {
          ok: false,
          results: [],
          infraError: lastError ?? "playwright chain execution failed",
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
