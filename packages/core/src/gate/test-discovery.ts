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

/** Package-runner prefixes a `test` script can put in front of the binary —
 *  `npx vitest` is as watch-mode as bare `vitest`, so the binary check must see
 *  through them. */
const RUNNER_PREFIX =
  /^(?:(?:npx|bunx|pnpm|yarn|pnpm\s+exec|npm\s+exec|bun\s+x|bun\s+run)\s+(?:--\s+)?)+/;

/** Any shell composition. A `--`-appended arg lands on the LAST command of a
 *  chain, never on the runner, so such a script can never be rewritten. */
const COMPOSITE_SCRIPT = /&&|\|\||;|\||>|</;

/** An explicit watch flag — `run` does NOT cancel it, so the script stays a hang. */
const WATCH_FLAG = /(^|\s)--watch(?:All)?(?:[=\s]|$)/;
/** `--watch=false` / `--watchAll=false`: an explicit one-shot opt-out. */
const WATCH_FLAG_OFF = /(^|\s)--watch(?:All)?=false(\s|$)/;

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

  if (WATCH_FLAG.test(s)) {
    return !WATCH_FLAG_OFF.test(s);
  }

  // Bare / arg-only vitest → watch. `vitest run …` is one-shot.
  const bin = s.replace(RUNNER_PREFIX, "");

  if (/^vitest(\s|$)/.test(bin)) {
    return !/(^|\s)run(\s|$)/.test(bin);
  }

  return false;
}

/**
 * True when appending `run` turns this watch script into a one-shot: a SINGLE
 * vitest invocation that is interactive only because the `run` subcommand is
 * missing. Anything else must not be rewritten — `bun run test -- run` appends
 * to the end of the whole script line, so `jest --watch` becomes `jest --watch
 * run` (still watching, gate hangs) and `vitest && tsc --noEmit` becomes
 * `… tsc --noEmit run` (tsc fails on a phantom file named `run`).
 */
function isRewritableToOneShot(script: string): boolean {
  if (COMPOSITE_SCRIPT.test(script) || WATCH_FLAG.test(script)) {
    return false;
  }

  return /^vitest(\s|$)/.test(script.replace(RUNNER_PREFIX, ""));
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

/** What package.json scripts yield for the gate. */
interface IScriptTestGate {
  /** The gate command, or null when no script is safely runnable. */
  readonly command: string | null;
  /** A real test script exists but cannot be made one-shot. Callers must NOT then
   *  fall back to `bun test`: those suites are written for another runner, so bun
   *  would report bogus failures instead of the project's real test result. */
  readonly unrunnable: boolean;
}

/** Resolve the gate test command from package.json scripts. */
function commandFromScripts(
  scripts: Readonly<Record<string, unknown>>
): IScriptTestGate {
  const ci = usableScript(scripts["test:ci"]);

  if (ci !== null && !isWatchTestScript(ci)) {
    return { command: "bun run test:ci", unrunnable: false };
  }

  const testScript = usableScript(scripts.test);

  if (testScript === null) {
    return { command: null, unrunnable: false };
  }

  if (!isWatchTestScript(testScript)) {
    return { command: "bun run test", unrunnable: false };
  }

  if (isRewritableToOneShot(testScript)) {
    // Append `run` so local vitest exits (BoringStack gate pattern).
    return { command: "bun run test -- run", unrunnable: false };
  }

  return { command: null, unrunnable: true };
}

/**
 * The project's test command for the gate, or null when there's nothing to run.
 * Prefers `test:ci` when present (exit-once CI script). Else uses `test`, but
 * rewrites bare-vitest watch mode to `bun run test -- run` so the gate cannot
 * hang. Falls back to `bun test` when test files exist without a script — but
 * NOT when a test script exists that we refuse to run (see `unrunnable`).
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

        if (fromScripts.command !== null) {
          return fromScripts.command;
        }

        if (fromScripts.unrunnable) {
          trace(
            "discoverTestCommand",
            `watch-only test script in ${cwd} — tests left out of the gate (add a one-shot "test:ci" script to include them)`
          );

          return null;
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
