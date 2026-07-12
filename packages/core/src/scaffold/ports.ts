import { createServer } from "node:net";

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
