import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { URL } from "node:url";

import type { Exec } from "../exec";
import { generateEntitySpec, specPath, stepTitle } from "./e2e-generator";
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
 * Type guard to validate a Playwright JSON report structure.
 */
interface IPlaywrightReportType {
  testResults: {
    testCaseTitle: string;
    title: string;
    ok: boolean;
    error?: { message?: string } | null;
  }[];
}

function isPlaywrightReport(obj: unknown): obj is IPlaywrightReportType {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "testResults" in obj &&
    Array.isArray(Object.getOwnPropertyDescriptor(obj, "testResults")?.value)
  );
}

/**
 * Map a Playwright test title to an AcceptStep.
 * Reverse of stepTitle() in the generator.
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

  for (const testResult of parsed.testResults) {
    const title =
      testResult.title.length > 0 ? testResult.title : testResult.testCaseTitle;
    const step = parseStep(title, entity);

    if (step !== null) {
      const errorMsg = testResult.error?.message;

      results.push({
        entity: entity.key,
        step,
        ok: testResult.ok,
        detail: testResult.ok ? "pass" : (errorMsg ?? "failed"),
      });
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
      ctx: IAcceptanceRunCtx
    ): Promise<IAcceptanceOutcome> {
      const spec = generateEntitySpec(entity);
      const path = specPath(ctx.cwd, entity.key);

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, spec, "utf-8");

      let lastError: string | undefined;

      for (let attempt = 0; attempt < 3; attempt++) {
        const uiPort = portFromURL(ctx.uiBase);
        const env = {
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
    },

    async runChain(
      spec: IAcceptanceSpec,
      ctx: IAcceptanceRunCtx
    ): Promise<IAcceptanceOutcome> {
      const allResults: IAcceptanceResult[] = [];

      for (const entity of spec.entities) {
        const outcome = await this.run(entity, ctx);

        if (outcome.infraError !== undefined) {
          return outcome;
        }

        allResults.push(...outcome.results);

        if (!outcome.ok) {
          break;
        }
      }

      return summarize(allResults);
    },
  };
}
