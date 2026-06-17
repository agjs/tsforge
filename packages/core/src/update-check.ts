import { readFileSync } from "node:fs";
import { mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./lib/guards";
import { STYLE, paint } from "./render";
import { ENV_FLAG, FLAG_ON } from "./config/config.constants";

/**
 * Startup "update available" check. Compares the running version against the
 * latest on the npm registry and surfaces a one-line notice under the banner.
 *
 * Two halves, both opt-out and offline-safe:
 *  - getUpdateNotice: reads a small on-disk cache (no network on the hot path)
 *    and returns a styled notice when the cached latest is newer.
 *  - refreshUpdateCacheInBackground: fire-and-forget; refreshes the cache from
 *    the registry when stale, for the next session.
 *
 * Everything is gated to interactive, non-CI, opted-in sessions (see
 * updateChecksEnabled) so eval sweeps and piped runs stay deterministic and
 * never touch the network.
 */

const REGISTRY_URL = "https://registry.npmjs.org/@agjs/tsforge/latest";
const TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_COMMAND = "bun install -g @agjs/tsforge";

export interface IUpdateCache {
  checkedAt: number;
  latest: string;
}

export interface IRegistryResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** Injectable seams so the logic is testable offline and deterministically. */
export interface IUpdateDeps {
  fetchFn: (url: string) => Promise<IRegistryResponse>;
  now: () => number;
  readCache: () => Promise<IUpdateCache | null>;
  writeCache: (data: IUpdateCache) => Promise<void>;
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

function parseVersion(v: string): [number, number, number] {
  const core = v.trim().replace(/^v/, "").split("-")[0] ?? "";
  const parts = core.split(".");

  const num = (s: string | undefined): number => {
    const n = Number.parseInt(s ?? "0", 10);

    return Number.isFinite(n) ? n : 0;
  };

  return [num(parts[0]), num(parts[1]), num(parts[2])];
}

/** True when `latest` is a strictly newer release than `current` (x.y.z, numeric
 *  compare; a leading `v` and any `-prerelease` suffix are ignored). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);

  if (a[0] !== b[0]) {
    return a[0] > b[0];
  }

  if (a[1] !== b[1]) {
    return a[1] > b[1];
  }

  return a[2] > b[2];
}

/** Run the update check only for an interactive, opted-in, non-CI session. */
export function updateChecksEnabled(
  env: Record<string, string | undefined>,
  isTTY: boolean
): boolean {
  if (!isTTY) {
    return false;
  }

  if (env[ENV_FLAG.noUpdateCheck] === FLAG_ON) {
    return false;
  }

  if (typeof env.CI === "string" && env.CI.length > 0) {
    return false;
  }

  return env.NO_UPDATE_NOTIFIER === undefined;
}

export function isCacheStale(cache: IUpdateCache | null, now: number): boolean {
  return cache === null || now - cache.checkedAt > CACHE_TTL_MS;
}

export async function fetchLatest(deps: IUpdateDeps): Promise<string | null> {
  try {
    const res = await deps.fetchFn(REGISTRY_URL);

    if (!res.ok) {
      return null;
    }

    const body: unknown = await res.json();

    return isRecord(body) && typeof body.version === "string"
      ? body.version
      : null;
  } catch {
    return null;
  }
}

function formatNotice(current: string, latest: string): string {
  return (
    paint("  ✦ tsforge ", STYLE.dim, true) +
    paint(latest, STYLE.brand + STYLE.bold, true) +
    paint(
      ` available (you have ${current}) — update: ${UPDATE_COMMAND}`,
      STYLE.dim,
      true
    )
  );
}

/** The styled one-line notice to print under the banner, or null when up to
 *  date / no cache / gated. Reads the cache only — never the network. */
export async function getUpdateNotice(
  current: string,
  overrides: Partial<IUpdateDeps> = {}
): Promise<string | null> {
  const deps = { ...defaultDeps(), ...overrides };

  if (!updateChecksEnabled(deps.env, deps.isTTY)) {
    return null;
  }

  const cache = await deps.readCache();

  if (cache === null || !isNewer(cache.latest, current)) {
    return null;
  }

  return formatNotice(current, cache.latest);
}

/** Refresh the cache from the registry when stale (gated). Exported for tests;
 *  the public entry point is refreshUpdateCacheInBackground. */
export async function refreshIfStale(deps: IUpdateDeps): Promise<void> {
  if (!updateChecksEnabled(deps.env, deps.isTTY)) {
    return;
  }

  const cache = await deps.readCache();

  if (!isCacheStale(cache, deps.now())) {
    return;
  }

  const latest = await fetchLatest(deps);

  if (latest !== null) {
    await deps.writeCache({ checkedAt: deps.now(), latest });
  }
}

/** Fire-and-forget background refresh — never awaited, never throws. */
export function refreshUpdateCacheInBackground(
  overrides: Partial<IUpdateDeps> = {}
): void {
  const deps = { ...defaultDeps(), ...overrides };

  void refreshIfStale(deps).catch(() => undefined);
}

let cachedVersion: string | null = null;

/** The running package's own version, read once from its package.json. */
export function currentVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }

  try {
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const data: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));

    cachedVersion =
      isRecord(data) && typeof data.version === "string"
        ? data.version
        : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }

  return cachedVersion;
}

function cacheDir(): string {
  return join(process.env.TSFORGE_HOME ?? homedir(), ".tsforge", "cache");
}

function cachePath(): string {
  return join(cacheDir(), "update-check.json");
}

async function readCacheFromDisk(): Promise<IUpdateCache | null> {
  try {
    const data: unknown = JSON.parse(await Bun.file(cachePath()).text());

    if (
      isRecord(data) &&
      typeof data.checkedAt === "number" &&
      typeof data.latest === "string"
    ) {
      return { checkedAt: data.checkedAt, latest: data.latest };
    }

    return null;
  } catch {
    return null;
  }
}

async function writeCacheToDisk(data: IUpdateCache): Promise<void> {
  await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
  await Bun.write(cachePath(), JSON.stringify(data, null, 2));
  await chmod(cachePath(), 0o600);
}

async function realFetch(url: string): Promise<IRegistryResponse> {
  return fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": `tsforge/${currentVersion()} (+update-check)` },
  });
}

function defaultDeps(): IUpdateDeps {
  return {
    fetchFn: realFetch,
    now: () => Date.now(),
    readCache: readCacheFromDisk,
    writeCache: writeCacheToDisk,
    env: process.env,
    isTTY: process.stdout.isTTY,
  };
}
