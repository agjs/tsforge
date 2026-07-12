import type { Exec } from "./exec";

/**
 * BoringStack's composed "done" gate, run exactly as a developer runs it by hand:
 * on disk in the clone, with deps installed and the repo root visible. It runs via
 * the injected Exec on-disk with the repo root + per-app node_modules visible (host
 * exec today), so meta-rules and tsc resolve — deps must be present and accessible.
 * The caller's Exec supplies the environment (notably a DATABASE_URL pointed at the
 * published localhost Postgres) so host-run tests / migrations reach the running stack.
 */
const GATE =
  "(cd apps/api && bun run validate) && (cd apps/ui && bun run validate) && bun run check";

export async function runBoringstackGate(
  cwd: string,
  exec: Exec
): Promise<{ passed: boolean; output: string }> {
  const result = await exec(["bash", "-lc", GATE], { cwd });

  return {
    passed: result.code === 0,
    output: result.stdout + result.stderr,
  };
}
