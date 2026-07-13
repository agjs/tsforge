import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The compose `.env` keys for every parameterized host-port binding in BoringStack
 * (mirrors the `${<KEY>:-<default>}` bindings across its compose files). Assigning a
 * free port to each and writing them to `compose/.env` lets a scaffolded project boot
 * ALONGSIDE the dev stack (or another project) without colliding on 5432/7330/7331/…
 * The compose files fall back to the upstream defaults when a key is unset, so this
 * only takes effect for projects tsforge configures.
 */
export const PORT_ENV_KEYS = [
  "POSTGRES_HOST_PORT",
  "VALKEY_HOST_PORT",
  "API_HOST_PORT",
  "UI_HOST_PORT",
  "UI_PREVIEW_HOST_PORT",
  "BULLMQ_HOST_PORT",
  "PROMETHEUS_HOST_PORT",
  "ALERTMANAGER_HOST_PORT",
  "GRAFANA_HOST_PORT",
  "GLITCHTIP_HOST_PORT",
  "MAILPIT_UI_HOST_PORT",
  "MAILPIT_SMTP_HOST_PORT",
  "WUD_HOST_PORT",
  "HTTP_HOST_PORT",
  "HTTPS_HOST_PORT",
] as const;

export type PortEnvKey = (typeof PORT_ENV_KEYS)[number];

/**
 * The upstream default host port for each binding — mirrors the `${KEY:-<default>}`
 * fallbacks in BoringStack's compose files. Used to (a) fill in a port the scaffold
 * didn't allocate and (b) remap a manifest health URL written against the defaults
 * to the project's actually-allocated port.
 */
export const DEFAULT_HOST_PORTS: Record<PortEnvKey, number> = {
  POSTGRES_HOST_PORT: 5432,
  VALKEY_HOST_PORT: 6379,
  API_HOST_PORT: 7330,
  UI_HOST_PORT: 7331,
  UI_PREVIEW_HOST_PORT: 7331,
  BULLMQ_HOST_PORT: 7332,
  PROMETHEUS_HOST_PORT: 9090,
  ALERTMANAGER_HOST_PORT: 9093,
  GRAFANA_HOST_PORT: 3010,
  GLITCHTIP_HOST_PORT: 8055,
  MAILPIT_UI_HOST_PORT: 8025,
  MAILPIT_SMTP_HOST_PORT: 1025,
  WUD_HOST_PORT: 3033,
  HTTP_HOST_PORT: 80,
  HTTPS_HOST_PORT: 443,
};

export type HostPorts = Partial<Record<PortEnvKey, number>>;

/**
 * Parse the compose `.env` content into a map of the host-port bindings tsforge
 * allocated for this project. Only well-formed `KEY=<positive int>` lines for a
 * known PORT_ENV_KEY are kept. Pure — unit-tested without the filesystem.
 */
export function parseHostPortsEnv(envContent: string): HostPorts {
  const values = new Map<string, string>();

  for (const line of envContent.split("\n")) {
    const eq = line.indexOf("=");

    if (eq >= 0) {
      values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }

  const out: HostPorts = {};

  for (const key of PORT_ENV_KEYS) {
    const raw = values.get(key);
    const port = raw === undefined ? NaN : Number(raw);

    if (Number.isInteger(port) && port > 0) {
      out[key] = port;
    }
  }

  return out;
}

/**
 * The allocated port for `key`, or its upstream default when the project didn't
 * allocate one (unconfigured repo, or a key outside the isolated set).
 */
export function hostPortOr(ports: HostPorts, key: PortEnvKey): number {
  return ports[key] ?? DEFAULT_HOST_PORTS[key];
}

/** The compose `.env` (relative to a clone root) that carries the allocated ports. */
export const COMPOSE_ENV_REL = "infra/compose/compose/.env";

/**
 * Read the host ports tsforge allocated for a scaffolded clone from its compose
 * `.env`. Returns `{}` when the file is absent (an unconfigured clone boots on the
 * upstream defaults), so callers fall back via `hostPortOr`.
 */
export function readHostPorts(cloneDir: string): HostPorts {
  const path = join(cloneDir, COMPOSE_ENV_REL);

  return existsSync(path) ? parseHostPortsEnv(readFileSync(path, "utf8")) : {};
}

/**
 * Rewrite a health/readiness URL written against the upstream default ports so it
 * targets this project's allocated ports. Matches the URL's port to the FIRST
 * PORT_ENV_KEY whose default equals it (PORT_ENV_KEYS order is stable, so 7331 →
 * UI_HOST_PORT, not UI_PREVIEW_HOST_PORT) and swaps in the allocated port. A URL on
 * a port that matches no default, or a key with no allocation, is returned unchanged.
 */
export function remapUrlToHostPorts(url: string, ports: HostPorts): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const urlPort = Number(parsed.port);

  if (!Number.isInteger(urlPort) || urlPort <= 0) {
    return url;
  }

  const key = PORT_ENV_KEYS.find((k) => DEFAULT_HOST_PORTS[k] === urlPort);
  const allocated = key === undefined ? undefined : ports[key];

  if (allocated === undefined) {
    return url;
  }

  parsed.port = String(allocated);

  return parsed.toString();
}

/** A free host port, assigned by the OS (bind port 0, read it back, release). Best
 *  effort: a port free now could be taken before boot, but that race is tiny and the
 *  next scaffold simply gets different ports. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();

    srv.once("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port =
        typeof addr === "object" && addr !== null ? addr.port : undefined;

      srv.close(() => {
        if (port === undefined) {
          reject(new Error("could not determine a free port"));

          return;
        }

        resolve(port);
      });
    });
  });
}

/** Assign a free host port to every parameterized binding, as `{key, port}` pairs
 *  ready to write as env edits. `allocate` is injected so the scaffold can be tested
 *  with a deterministic stub instead of real sockets. */
export async function allocateHostPorts(
  allocate: () => Promise<number> = findFreePort
): Promise<{ key: PortEnvKey; port: number }[]> {
  const out: { key: PortEnvKey; port: number }[] = [];

  for (const key of PORT_ENV_KEYS) {
    out.push({ key, port: await allocate() });
  }

  return out;
}
