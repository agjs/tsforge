import type { IReadyPoller, IScaffoldRunner } from "./io";
import type { IScaffoldManifest } from "./scaffold.types";
import { remapUrlToHostPorts, type HostPorts } from "./ports";

/** Default per-URL readiness budget — a cold `docker compose up --build` pulling
 *  images + running migrations is slow on first boot. */
const DEFAULT_BOOT_TIMEOUT_MS = 180_000;

export interface IBootDeps {
  readonly run: IScaffoldRunner;
  readonly poll: IReadyPoller;
  /** Per-health-URL readiness timeout (ms). */
  readonly timeoutMs?: number;
  /** The project's allocated host ports. When present, the manifest health URLs
   *  (written against the upstream defaults, e.g. :7330) are remapped to these, so
   *  an isolated boot polls the ports the stack actually published — without this
   *  the health check hits the default ports and falsely reports a boot failure. */
  readonly hostPorts?: HostPorts;
}

export interface IBootResult {
  readonly booted: boolean;
  readonly statuses: readonly { url: string; status: number | null }[];
  /** Set when the boot command itself failed (before any polling). */
  readonly error?: string;
}

/**
 * Boot the scaffolded full stack by running boringstack's OWN boot command
 * (manifest `archetypes.boringstack.boot`, e.g. `bash setup.sh --up` → `dev.sh up`)
 * then health-polling each manifest URL until it answers < 500. This is a
 * SCAFFOLD-TIME gate (once, at setup), not the per-edit accept gate. `booted` is
 * true only when the command exited 0 AND every health URL came up.
 */
export async function bootStack(
  dir: string,
  manifest: IScaffoldManifest,
  deps: IBootDeps
): Promise<IBootResult> {
  const profile = manifest.archetypes.boringstack;
  const command = profile.boot;

  if (command === undefined || command.length === 0) {
    return {
      booted: false,
      statuses: [],
      error: "manifest has no boot command",
    };
  }

  // The boot string is a controlled manifest value (may contain shell), so run it
  // through `sh -c` rather than splitting it into an argv.
  const result = await deps.run(dir, ["sh", "-c", command]);

  if (result.exitCode !== 0) {
    return {
      booted: false,
      statuses: [],
      error: `boot command failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
    };
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const hostPorts = deps.hostPorts ?? {};
  const urls = (profile.healthUrls ?? []).map((u) =>
    remapUrlToHostPorts(u, hostPorts)
  );
  const statuses: { url: string; status: number | null }[] = [];

  for (const url of urls) {
    statuses.push({ url, status: await deps.poll(url, timeoutMs) });
  }

  const unreachable = statuses.filter((s) => s.status === null);

  return {
    booted: unreachable.length === 0,
    statuses,
    // A timed-out health check IS a boot failure — surface it as an error so
    // callers (cli/headless) exit non-zero instead of silently reporting
    // `booted: false` and exiting 0.
    ...(unreachable.length === 0
      ? {}
      : {
          error: `boot health check failed — no response within ${String(timeoutMs)}ms: ${unreachable.map((s) => s.url).join(", ")}`,
        }),
  };
}
