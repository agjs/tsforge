import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for #63: the harness-review panel's pre-review step runs
 * `bun run validate`, whose `test` step is a bare `bun test`. Bun's DEFAULT test
 * timeout is 5s, and the harness's hermetic AgentRunner tests (~2s each) blow that
 * cap under the panel's concurrent reviewer load — a flaky non-zero exit that
 * false-BLOCKs EVERY PR before a single reviewer runs (live-observed on the #198
 * panel). The panel-endorsed fix (rejected alternative: narrowing validate to a
 * static subset — gate-relaxing) is to raise the timeout so correct-but-slow tests
 * finish; a longer ceiling hides no real failure (a hung/broken test still fails).
 *
 * `timeout` is NOT honored in bunfig.toml's `[test]` block on this bun version
 * (verified: a 6s test times out at 5s despite `timeout = 8000`), so the CLI flag on
 * the script is the only working mechanism. This test pins it so it can't be
 * silently dropped and reintroduce the flake.
 */
test("root `test` script sets an explicit non-default --timeout (kills the #63 panel false-BLOCK)", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf-8")
  ) as { scripts?: Record<string, string> };

  const testScript = pkg.scripts?.test ?? "";

  expect(testScript).toContain("bun test");

  const match = /--timeout\s+(\d+)/u.exec(testScript);

  // The flag must be present…
  expect(match).not.toBeNull();
  // …with a value well above bun's 5000ms default, so the AgentRunner suite has
  // headroom under the panel's concurrent load.
  expect(Number(match?.[1] ?? 0)).toBeGreaterThanOrEqual(20000);
});
