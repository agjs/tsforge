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
/**
 * FAST convergence gate — run every model cycle. Each app's `check` (lint +
 * typecheck + meta-rules + knip; UI adds format) plus the cheap API test suite. It
 * enforces EVERY lint/type/meta/knip rule (zero enforcement lost) but deliberately
 * omits the slow acceptance-only work that `validate` bundles — the production build,
 * `size:check` (measured 114s+), and full UI coverage — which catch nothing the model
 * needs per turn. This is what took a failing cycle from ~65s toward ~10s. The UI
 * stage still regenerates the OpenAPI client (`generate:api`) first, so the UI never
 * checks against a stale `schema.d.ts`.
 */
/** Emit the app's OWN eslint (same config + file globs) as STRUCTURED JSON, wrapped
 *  in markers, so the failure parser reads exact {file,line,rule,message} instead of
 *  scraping eslint's ambiguous "stylish" text (which truncated multi-line messages and
 *  mis-attributed interleaved output). `bun run --silent lint -- --format json` reuses
 *  the app's `lint` script and appends `--format json`, so there's no coupling to the
 *  app's glob list. Runs BEFORE `check` and never aborts (`|| true`) — it's a parsing
 *  aid; `check` still owns pass/fail (its own eslint sets the exit code). */
const eslintJson = (): string =>
  "{ echo '::tsforge-eslint-json::'; " +
  "bun run --silent lint -- --format json 2>/dev/null || true; " +
  "echo '::tsforge-eslint-json-end::'; }";

const FAST_GATE =
  `echo '::tsforge-app apps/api::' && (cd apps/api && ${eslintJson()} && bun run check && bun run test) && ` +
  `echo '::tsforge-app apps/ui::' && (cd apps/ui && bun run generate:api && ${eslintJson()} && bun run check)`;

/**
 * FULL acceptance gate — run ONCE, when every feature has passed the fast gate. The
 * complete `validate` for both apps (adds full tests/coverage, production build,
 * size checks) plus the repo-root drift check. This is the authoritative "the whole
 * app is really green" gate; nothing that used to run is dropped, it just runs once
 * at the end instead of every turn.
 */
const FULL_GATE =
  `echo '::tsforge-app apps/api::' && (cd apps/api && ${eslintJson()} && bun run validate) && ` +
  `echo '::tsforge-app apps/ui::' && (cd apps/ui && bun run generate:api && ${eslintJson()} && bun run validate) && ` +
  "echo '::tsforge-app .::' && bun run check";

export type GateMode = "fast" | "full";

export async function runBoringstackGate(
  cwd: string,
  exec: Exec,
  mode: GateMode = "fast"
): Promise<{ passed: boolean; output: string }> {
  const gate = mode === "full" ? FULL_GATE : FAST_GATE;
  const result = await exec(["bash", "-lc", gate], { cwd });

  return {
    passed: result.code === 0,
    output: result.stdout + result.stderr,
  };
}
