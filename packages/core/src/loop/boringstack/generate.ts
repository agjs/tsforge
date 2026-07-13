import { existsSync } from "node:fs";

import { wireResource } from "./wire-resource";
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
  // scaffold + wire when the resource doesn't exist yet; always re-run the
  // downstream sync (format + db:push) so a schema/format tweak is reflected.
  if (!existsSync(`${apiCwd}/src/api/${camel}`)) {
    await execOrThrow(exec, ["bun", "run", "new:resource", "--", name], apiCwd);

    await wireResource(cwd, name);
  }

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
 *  OPENAPI_URL when set (else BoringStack's dev default :7330). */
async function waitForApiReady(exec: Exec, cwd: string): Promise<void> {
  const url = process.env.OPENAPI_URL ?? "http://localhost:7330/swagger/json";

  await execOrThrow(
    exec,
    [
      "bash",
      "-lc",
      `for i in $(seq 1 45); do curl -sf -o /dev/null "${url}" && exit 0; sleep 2; done; echo "api not ready at ${url} after 90s" >&2; exit 1`,
    ],
    cwd
  );
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

  // The API must be serving its (reloaded) OpenAPI spec before generate:api fetches it.
  await waitForApiReady(exec, cwd);

  await execOrThrow(exec, ["bun", "run", "generate:api"], uiCwd);
}
