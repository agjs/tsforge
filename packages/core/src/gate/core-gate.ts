import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { IGateSpec } from "./types";
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
import type { IExternalPlugin } from "../config/external-plugins";

/** tsforge's per-project cache namespace (git-ignored, next to the tsc
 *  buildinfo). The syntactic-lint result cache lives here. */
const GATE_CACHE_DIR = ".tsforge";

/** The eslint result cache path, KEYED BY the active ruleset. eslint caches on file
 *  content + the static config PATH — NOT the packs/overrides/conventions we inject via
 *  env (TSFORGE_PACKS, …). The auto gate can change packs mid-session (a greenfield project
 *  gains `react`), so a single fixed cache path would let files cached under the weaker
 *  ruleset keep passing without the newly activated rules. Hashing the env prefix (the
 *  exact ruleset) into the filename means a ruleset change → a fresh cache → a real re-lint,
 *  while an unchanged ruleset still hits the cache. */
function eslintCachePath(envPrefix: string): string {
  const key = Bun.hash(`v1:${envPrefix}`).toString(36);

  return `${GATE_CACHE_DIR}/eslint-gate-${key}.cache`;
}

export async function buildGate(
  cwd: string,
  packs?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>,
  options?: {
    enableTypeAware?: boolean;
    includeTests?: boolean;
    /** An explicit test command to use instead of re-discovering one. `undefined`
     *  discovers from the project (default); a string or `null` is used verbatim. The
     *  auto-gate passes its FROZEN command (captured once at session start) so a cycle
     *  can't re-discover a weaker one — e.g. a real suite swapped for a noop script. */
    testCommand?: string | null;
    conventions?: IConventions;
    /** External rule-pack plugins to register inside the spawned gate, so their
     *  pack ids resolve there as they do in the orchestrator process. */
    plugins?: readonly IExternalPlugin[];
  }
): Promise<IGateSpec> {
  const parts: string[] = [];
  const labels: string[] = [];

  const tsc = await tscPart(cwd);

  if (tsc !== null) {
    parts.push(tsc);
    labels.push("tsc --strict");
  }

  // The syntactic lint pass caches per-file results under .tsforge/ (see
  // lintPart). Create the dir in-process — cross-platform and in the TARGET cwd
  // — rather than via a shell `mkdir` in the command: a lint-only project skips
  // tscPart (which otherwise makes the dir), and process.cwd() is not the gate's
  // cwd, so a builtin here would be both redundant and, if done in-code naively,
  // wrong-directory.
  mkdirSync(join(cwd, GATE_CACHE_DIR), { recursive: true });

  const lint = lintPart(
    packs,
    ruleOverrides,
    options?.conventions,
    options?.plugins
  );

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
    const test =
      options.testCommand === undefined
        ? await discoverTestCommand(cwd)
        : options.testCommand;

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
  conventions?: IConventions,
  plugins?: readonly IExternalPlugin[]
): IGateSpec {
  // Result caching is sound here because this pass is syntactic-only: a file's lint
  // result depends on that file alone plus the active ruleset. eslint keys cache entries
  // on file content + the static config path — NOT the packs/overrides we inject via env,
  // so the cache path is keyed by the ruleset (eslintCachePath) to stay correct when the
  // auto gate changes packs mid-session. The type-aware pass below must stay UNCACHED —
  // editing one file can change type errors in an untouched one. Every repair cycle
  // re-runs the gate, so on all but the first cycle this skips re-linting the (usually
  // vast) majority of unchanged files. buildGate creates the .tsforge/ dir before this runs.
  const envPrefix = packEnvPrefix(packs, ruleOverrides, conventions, plugins);

  return {
    command: `${envPrefix}bun "${ESLINT_BIN}" --no-config-lookup -c "${STRICT_CONFIG}" --cache --cache-location "${eslintCachePath(envPrefix)}" --format json .`,
    label: "strict TypeScript (tsforge)",
  };
}

/** Optional type-aware async rules — only when target has tsconfig.json. */
async function typeAwareLintPart(cwd: string): Promise<IGateSpec | null> {
  const hasTsconfig = await Bun.file(join(cwd, PROJECT_TSCONFIG)).exists();

  if (!hasTsconfig) {
    return null;
  }

  return {
    command: `bun "${ESLINT_BIN}" --no-config-lookup -c "${TYPE_AWARE_CONFIG}" --format json .`,
    label: "type-aware async (tsforge)",
  };
}
