import { join } from "node:path";
import type { IGate } from "./types";
import {
  ESLINT_BIN,
  PRETTIER_BIN,
  STRICT_CONFIG,
  TYPE_AWARE_CONFIG,
  TEST_COVERAGE_CHECK,
  BOOT_CHECK,
  PROPTEST_CHECK,
} from "./tool-paths";
import { packEnvPrefix } from "./shell";
import { tscPart, PROJECT_TSCONFIG } from "./tsconfig";
import { discoverTestCommand } from "./test-discovery";
import type { IConventions } from "../infer-rules/conventions.types";

export async function buildGate(
  cwd: string,
  packs?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>,
  options?: {
    enableTypeAware?: boolean;
    includeTests?: boolean;
    conventions?: IConventions;
  }
): Promise<IGate> {
  const parts: string[] = [];
  const labels: string[] = [];

  const tsc = await tscPart(cwd);

  if (tsc !== null) {
    parts.push(tsc);
    labels.push("tsc --strict");
  }

  const lint = lintPart(packs, ruleOverrides, options?.conventions);

  parts.push(lint.command);
  labels.push(lint.label);

  if (options?.enableTypeAware === true) {
    const typeAware = await typeAwareLintPart(cwd);

    if (typeAware !== null) {
      parts.push(typeAware.command);
      labels.push(typeAware.label);
    }
  }

  // Tests run LAST (after the cheap static floor) so a type/lint error fails
  // fast without paying for a test run. Only appended when the project actually
  // has tests to run — a strict-floor-only run, or a project with none, skips it.
  if (options?.includeTests === true) {
    const test = await discoverTestCommand(cwd);

    if (test !== null) {
      parts.push(test);
      labels.push("tests");
    }
  }

  appendOptInOracles(parts, labels, process.env);

  return { command: parts.join(" && "), label: labels.join(" + ") };
}

/**
 * Opt-in quality oracles (default OFF, mirroring the web a11y/screenshot flags).
 * They run AFTER tests and read their own config from env, so the gate command
 * stays free of shell-quoting:
 *   - TSFORGE_COVERAGE=<pct> — fail if line coverage is below the floor.
 *   - TSFORGE_BOOT="<start cmd>" — boot the server and require a non-5xx response.
 *   - TSFORGE_PROPTEST=1 — fuzz exported functions from their types; fail if any
 *     throws on valid typed input.
 */
function appendOptInOracles(
  parts: string[],
  labels: string[],
  env: Record<string, string | undefined>
): void {
  if (env.TSFORGE_COVERAGE !== undefined && env.TSFORGE_COVERAGE.length > 0) {
    parts.push(`bun "${TEST_COVERAGE_CHECK}"`);
    labels.push("test coverage");
  }

  if (env.TSFORGE_BOOT !== undefined && env.TSFORGE_BOOT.trim().length > 0) {
    parts.push(`bun "${BOOT_CHECK}"`);
    labels.push("boot smoke");
  }

  if (env.TSFORGE_PROPTEST === "1") {
    parts.push(`bun "${PROPTEST_CHECK}"`);
    labels.push("property tests");
  }
}

/**
 * The core (non-web) auto-fix command — same janitor as buildWebFix but uses the
 * bundled strict.eslint.config.mjs. Run BEFORE the gate each cycle so padding-line,
 * prefer-const, curly, etc. are squashed without model turns.
 */
export function buildCoreFix(): string {
  const lintFix =
    `"${ESLINT_BIN}" --no-config-lookup -c "${STRICT_CONFIG}" --fix .`.replace(
      /\s+/g,
      " "
    );
  const format = `"${PRETTIER_BIN}" --write .`;

  return `${lintFix} ; ${format}`;
}

/** The syntactic idiom layer — ALWAYS tsforge's bundled strict eslint config
 *  (user policy). We deliberately do NOT defer to the project's own `lint`
 *  script: that's exactly how a weak repo would dodge the strict-TS floor. The
 *  bundled config needs no deps in the target. When packs are provided, they
 *  are passed via TSFORGE_PACKS env var so the config can load TS imports. Rule
 *  overrides are passed via TSFORGE_RULE_OVERRIDES (JSON-encoded map). */
function lintPart(
  packs?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>,
  conventions?: IConventions
): IGate {
  return {
    command: `${packEnvPrefix(packs, ruleOverrides, conventions)}bun "${ESLINT_BIN}" --no-config-lookup -c "${STRICT_CONFIG}" --format json .`,
    label: "strict TypeScript (tsforge)",
  };
}

/** Optional type-aware async rules — only when target has tsconfig.json. */
async function typeAwareLintPart(cwd: string): Promise<IGate | null> {
  const hasTsconfig = await Bun.file(join(cwd, PROJECT_TSCONFIG)).exists();

  if (!hasTsconfig) {
    return null;
  }

  return {
    command: `bun "${ESLINT_BIN}" --no-config-lookup -c "${TYPE_AWARE_CONFIG}" --format json .`,
    label: "type-aware async (tsforge)",
  };
}
