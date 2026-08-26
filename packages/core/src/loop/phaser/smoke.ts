import type { Exec } from "./exec";

/**
 * Harness-owned Playwright smoke. Never exposed as a model `run` command.
 * The template's `bun run test:smoke` boots Vite the way playwright.config does.
 */
export async function runPhaserSmoke(
  cwd: string,
  exec: Exec
): Promise<{ readonly ok: boolean; readonly output: string }> {
  const result = await exec(["bun", "run", "test:smoke"], { cwd });
  const output = `${result.stdout}\n${result.stderr}`;

  return { ok: result.code === 0, output };
}
