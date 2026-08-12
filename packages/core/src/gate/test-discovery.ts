import { join } from "node:path";
import { isRecord } from "../lib/guards";
import { trace } from "../lib/trace";
import { isWorkspaceContainer } from "./workspace-root";

/** The npm-init placeholder test script — running it always fails, so it must
 *  NOT count as "the project has tests". */
const PLACEHOLDER_TEST = /no test specified/i;

/** Extensions a test/spec file can have. Used by core glob discovery
 *  (`hasTestFiles`) so the file extension detection is consistent. */
const TEST_EXTS = ["ts", "tsx", "js", "jsx"] as const;

/**
 * True when a package.json `test` script is watch-mode by default (would hang a
 * gate). vitest without `run` stays interactive; explicit `--watch` is always a
 * hang. Jest defaults to one-shot, so only flagged watch forms count.
 */
export function isWatchTestScript(script: string): boolean {
  const s = script.trim();

  if (s.length === 0) {
    return false;
  }

  if (/(^|\s)--watch(?:All)?(\s|$)/.test(s)) {
    return true;
  }

  // Bare / arg-only vitest → watch. `vitest run …` is one-shot.
  if (/^vitest(\s|$)/.test(s)) {
    return !/(^|\s)run(\s|$)/.test(s);
  }

  return false;
}

function usableScript(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || PLACEHOLDER_TEST.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/** Resolve gate test argv from package.json scripts, or null to fall through. */
function commandFromScripts(
  scripts: Readonly<Record<string, unknown>>
): string | null {
  if (usableScript(scripts["test:ci"]) !== null) {
    return "bun run test:ci";
  }

  const testScript = usableScript(scripts.test);

  if (testScript === null) {
    return null;
  }

  if (isWatchTestScript(testScript)) {
    // Append `run` so local vitest exits (BoringStack gate pattern).
    return "bun run test -- run";
  }

  return "bun run test";
}

/**
 * The project's test command for the gate, or null when there's nothing to run.
 * Prefers `test:ci` when present (exit-once CI script). Else uses `test`, but
 * rewrites watch-mode vitest to `bun run test -- run` so the gate cannot hang.
 * Falls back to `bun test` when test files exist without a script.
 */
export async function discoverTestCommand(cwd: string): Promise<string | null> {
  // A multi-package workspace root is not a test project — nested suites belong
  // to child packages (gated there when those packages are edited).
  if (isWorkspaceContainer(cwd)) {
    return null;
  }

  const pkgFile = Bun.file(join(cwd, "package.json"));

  if (await pkgFile.exists()) {
    try {
      const pkg: unknown = await pkgFile.json();
      const scripts = isRecord(pkg) ? pkg.scripts : undefined;

      if (isRecord(scripts)) {
        const fromScripts = commandFromScripts(scripts);

        if (fromScripts !== null) {
          return fromScripts;
        }
      }
    } catch (err) {
      // Malformed package.json — fall through to file detection.
      trace("discoverTestCommand", err);
    }
  }

  return (await hasTestFiles(cwd)) ? "bun test" : null;
}

/** True when the project has at least one *.test.* / *.spec.* file (outside
 *  node_modules) — the signal that a bare `bun test` has something to run. */
async function hasTestFiles(cwd: string): Promise<boolean> {
  const glob = new Bun.Glob(`**/*.{test,spec}.{${TEST_EXTS.join(",")}}`);

  for await (const path of glob.scan({ cwd, onlyFiles: true })) {
    if (!path.includes("node_modules")) {
      return true;
    }
  }

  return false;
}
