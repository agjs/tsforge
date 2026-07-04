import { join } from "node:path";
import { isRecord } from "../lib/guards";
import { trace } from "../lib/trace";

/** The npm-init placeholder test script — running it always fails, so it must
 *  NOT count as "the project has tests". */
const PLACEHOLDER_TEST = /no test specified/i;

/** Extensions a test/spec file can have. SINGLE source for both the core glob
 *  discovery (`hasTestFiles`) and the web gate's shell probe (`webTestProbe`) so
 *  the two never drift on what counts as a test. */
const TEST_EXTS = ["ts", "tsx", "js", "jsx"] as const;

/** Directories never searched for tests (deps + build output). */
const TEST_PRUNE_DIRS = ["node_modules", "dist", "build", ".tsforge"] as const;

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

/** A shell snippet that runs `bun test` IFF the project has any test/spec file
 *  (anywhere outside deps/build), matching the SAME extension set as the core
 *  `hasTestFiles` discovery. Evaluated at gate-RUN time, not build time, so a
 *  test the model adds mid-build is picked up; the `find` guard is required
 *  because `bun test` exits non-zero when it finds NO tests (which would wrongly
 *  fail a freshly scaffolded app). Crucially the probe is project-wide — a
 *  mirrored `tests/` file (which satisfies test-sibling-required) is run too, not
 *  just co-located `src/` tests, so the web gate can't skip a required test. */
export function webTestProbe(): string {
  const names = TEST_EXTS.flatMap((e) => [
    `-name '*.test.${e}'`,
    `-name '*.spec.${e}'`,
  ]).join(" -o ");
  const prune = TEST_PRUNE_DIRS.map((d) => `-name ${d}`).join(" -o ");
  const find = `find . -type d \\( ${prune} \\) -prune -o -type f \\( ${names} \\) -print`;

  return `if ${find} 2>/dev/null | grep -q .; then bun test; fi`;
}
