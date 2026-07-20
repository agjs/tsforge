import { existsSync } from "node:fs";

import { wireResource, wireUiFeature } from "./wire-resource";
import { toCamelCase } from "./case";
import type { Exec } from "./exec";

function makeErrorWithStderr(stderr: string): Error {
  return new Error(stderr);
}

async function execOrThrow(
  exec: Exec,
  argv: readonly string[],
  cwd: string
): Promise<void> {
  const result = await exec(argv, { cwd });

  if (result.code !== 0) {
    throw makeErrorWithStderr(result.stderr);
  }
}

export async function generateResource(
  cwd: string,
  name: string,
  exec: Exec
): Promise<void> {
  const apiCwd = `${cwd}/apps/api`;
  const camel = toCamelCase(name);

  // IDEMPOTENT on retry: `new:resource` refuses to overwrite an existing resource
  // dir, so on a second attempt (the model is fixing gate failures) we must NOT
  // regenerate — that would crash AND clobber the model's in-progress fixes. Only
  // SCAFFOLD when the resource doesn't exist yet.
  if (!existsSync(`${apiCwd}/src/api/${camel}`)) {
    await execOrThrow(exec, ["bun", "run", "new:resource", "--", name], apiCwd);
  }

  // …but WIRE on EVERY attempt — this is the API analog of generateFeature's
  // unconditional `wireUiFeature`. Mounting the route (routes map + app `.group` +
  // swagger) was previously gated on the scaffold branch, so once the dir existed —
  // a pre-existing dir, or a near-green rollback that reverted the mount — the route
  // was NEVER mounted again: knip `unused file` + an unreachable route → park
  // (observed live, build13). wireResource is idempotent (each wire* checks it isn't
  // already present), so re-running it every attempt is safe and self-heals a lost mount.
  await wireResource(cwd, name);

  // Format with BoringStack's OWN pinned prettier (its `format` script), NEVER
  // `bunx prettier` — bunx pulls the latest prettier, which formats differently
  // (e.g. union types) than the pinned version the gate checks against, so the
  // just-formatted output would then FAIL the gate's format check.
  await execOrThrow(exec, ["bun", "run", "format"], apiCwd);

  // `--force` auto-approves drizzle-kit's data-loss statements so `db:push` never
  // blocks on its interactive confirmation prompt (which hangs forever in the
  // harness's non-TTY exec). Safe here: the build DB holds no real data, and when
  // the model iterates on a schema the drop/recreate MUST proceed unattended.
  await execOrThrow(exec, ["bun", "run", "db:push", "--", "--force"], apiCwd);
}

/** Poll the running API's OpenAPI spec until it responds. After `new:resource` +
 *  `db:push` the dev server hot-reloads; `generate:api` then fetches that spec, so
 *  without a readiness wait it races the reload and dies with "fetch failed". Uses
 *  OPENAPI_URL when set (else BoringStack's dev default :7330). Returns whether the
 *  API came ready (does NOT throw) — a persistently-down API is almost always the
 *  model's own in-progress code crashing the dev server, and the caller must NOT
 *  dead-end the build on it. */
async function apiIsReady(exec: Exec, cwd: string): Promise<boolean> {
  const url = process.env.OPENAPI_URL ?? "http://localhost:7330/swagger/json";

  const res = await exec(
    [
      "bash",
      "-lc",
      `for i in $(seq 1 45); do curl -sf -o /dev/null "${url}" && exit 0; sleep 2; done; exit 1`,
    ],
    { cwd }
  );

  return res.code === 0;
}

export async function generateFeature(
  cwd: string,
  name: string,
  exec: Exec
): Promise<void> {
  const uiCwd = `${cwd}/apps/ui`;
  const camel = toCamelCase(name);

  // IDEMPOTENT on retry (same reason as generateResource): don't re-scaffold an
  // existing UI feature — preserve the model's fixes; always re-sync generate:api.
  if (!existsSync(`${uiCwd}/src/features/${camel}`)) {
    await execOrThrow(exec, ["bun", "run", "new:feature", name], uiCwd);
  }

  // Register the feature's page in the SPA router — boringstack's new:feature
  // leaves routing manual, so without this the page is gate-green but UNREACHABLE
  // (no URL/nav). Deterministic + idempotent, so it's safe on the retry path too.
  await wireUiFeature(cwd, name);

  // The API must be serving its (reloaded) OpenAPI spec before generate:api fetches
  // it. If it never comes ready, that is almost always the model's OWN in-progress
  // code crashing the dev server (e.g. a Drizzle column type used without importing
  // it → ReferenceError on boot). Do NOT abort the build here — skip the client sync
  // and let the GATE surface the real, actionable compiler error (which the model can
  // fix), instead of dead-ending every later attempt at "api not ready". The next
  // attempt, once the model fixes the schema, re-runs generate:api against a healthy API.
  if (!(await apiIsReady(exec, cwd))) {
    return;
  }

  await execOrThrow(exec, ["bun", "run", "generate:api"], uiCwd);
}
