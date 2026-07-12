import type { Exec } from "./exec";

const GATE_IMAGE = "boringstack-api-dev";
const GATE =
  "(cd apps/api && bun run validate) && (cd apps/ui && bun run validate) && bun run check";

export async function runBoringstackGate(
  cwd: string,
  exec: Exec
): Promise<{ passed: boolean; output: string }> {
  const argv = [
    "docker",
    "run",
    "--rm",
    "-v",
    `${cwd}:/repo`,
    "-w",
    "/repo",
    GATE_IMAGE,
    "sh",
    "-lc",
    GATE,
  ] as const;

  const result = await exec(argv, { cwd });

  return {
    passed: result.code === 0,
    output: result.stdout + result.stderr,
  };
}
