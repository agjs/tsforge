import { join } from "node:path";
import { isRecord } from "../lib/guards";
import { trace } from "../lib/trace";

/** The npm-init placeholder test script — running it always fails, so it must
 *  NOT count as "the project has tests". */
const PLACEHOLDER_TEST = /no test specified/i;

/** Extensions a test/spec file can have. Used by core glob discovery
 *  (`hasTestFiles`) so the file extension detection is consistent. */
const TEST_EXTS = ["ts", "tsx", "js", "jsx"] as const;

/**
 * The project's test command for the gate, or null when there's nothing to run.
 * Prefers an explicit, real package.json `test` script (run via `bun run test`);
 * else falls back to `bun test` when the project has test files; else null — so
 * a greenfield app with no tests yet stays at the strict floor instead of
 * failing a gate that runs a placeholder/absent test command.
 */
export async function discoverTestCommand(cwd: string): Promise<string | null> {
  const pkgFile = Bun.file(join(cwd, "package.json"));

  if (await pkgFile.exists()) {
    try {
      const pkg: unknown = await pkgFile.json();
      const scripts = isRecord(pkg) ? pkg.scripts : undefined;
      const script = isRecord(scripts) ? scripts.test : undefined;

      if (
        typeof script === "string" &&
        script.trim().length > 0 &&
        !PLACEHOLDER_TEST.test(script)
      ) {
        return "bun run test";
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
