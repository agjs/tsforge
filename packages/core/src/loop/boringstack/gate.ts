import type { Exec } from "./exec";

/**
 * BoringStack's composed "done" gate, run exactly as a developer runs it by hand:
 * on disk in the clone, with deps installed and the repo root visible. It runs via
 * the injected Exec on-disk with the repo root + per-app node_modules visible (host
 * exec today), so meta-rules and tsc resolve — deps must be present and accessible.
 * The caller's Exec supplies the environment (notably a DATABASE_URL pointed at the
 * published localhost Postgres) so host-run tests / migrations reach the running stack.
 */
// App markers (`::tsforge-app <prefix>::`) are echoed before each stage so the
// failure parser can attribute a stage's app-relative paths (e.g. knip's
// `src/api/note/…` printed inside `apps/api`) back to their repo-relative form
// (`apps/api/src/api/note/…`). Without this a knip "unused file" path doesn't match
// the model's editable scope and the loop drops it as read-only. The echoes always
// exit 0, so the `&&` short-circuit (stop at the first failing stage) is preserved.
// The UI stage regenerates the typed OpenAPI client from the LIVE API
// (`generate:api`) BEFORE it validates. This runs every gate cycle — not just at
// scaffold time — so after the model changes the API schema/routes the UI never
// validates against a stale `schema.d.ts` (the stale-client drift that pushed a live
// run into illegal `as` casts and raw-fetch workarounds). API validate runs FIRST,
// so a broken API surfaces as an API failure, not a confusing UI type error; only
// once the API is healthy do we resync + validate the UI. `schema.d.ts` is
// harness-owned (outside the model's editable scope) — the gate regenerates it, the
// model never hand-edits it.
const GATE =
  "echo '::tsforge-app apps/api::' && (cd apps/api && bun run validate) && " +
  "echo '::tsforge-app apps/ui::' && (cd apps/ui && bun run generate:api && bun run validate) && " +
  "echo '::tsforge-app .::' && bun run check";

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
