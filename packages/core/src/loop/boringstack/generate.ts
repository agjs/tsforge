import { wireResource } from "./wire-resource";
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

  await execOrThrow(exec, ["bun", "run", "new:resource", "--", name], apiCwd);

  await wireResource(cwd, name);

  // Format with BoringStack's OWN pinned prettier (its `format` script), NEVER
  // `bunx prettier` — bunx pulls the latest prettier, which formats differently
  // (e.g. union types) than the pinned version the gate checks against, so the
  // just-formatted output would then FAIL the gate's format check.
  await execOrThrow(exec, ["bun", "run", "format"], apiCwd);

  await execOrThrow(exec, ["bun", "run", "db:push"], apiCwd);
}

export async function generateFeature(
  cwd: string,
  name: string,
  exec: Exec
): Promise<void> {
  const uiCwd = `${cwd}/apps/ui`;

  await execOrThrow(exec, ["bun", "run", "new:feature", name], uiCwd);

  await execOrThrow(exec, ["bun", "run", "generate:api"], uiCwd);
}
