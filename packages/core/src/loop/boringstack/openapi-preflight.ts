import { isRecord } from "../../lib/guards";

/** The BoringStack UI regenerates its typed API client from the running API's
 *  OpenAPI spec (`bun run generate:api`) on EVERY gate cycle. If that spec URL is
 *  unreachable, generate:api exits non-zero with output the gate parser can't
 *  classify — an opaque `gate-nonzero` the MODEL cannot fix, which oscillated a
 *  live build for 5 cycles then regressed. Pre-flighting the endpoint once, before
 *  the loop, turns that into a single clear infra failure (fail-closed) instead. */

/** Minimal shape of the fetch result we care about — so a test can inject a fake
 *  without constructing a whole Response. */
export interface IHttpProbe {
  ok: boolean;
  status: number;
}

export interface IWaitForOpenApiOpts {
  /** Total budget before giving up (default 60s — a cold API can take a while). */
  timeoutMs?: number;
  /** Delay between attempts (default 1s). */
  intervalMs?: number;
  /** Per-attempt hard cap (default 10s) so a hung connect can't block the whole
   *  budget — the real probe aborts the fetch after this. */
  perAttemptMs?: number;
  /** Injected probe; defaults to a real `fetch` (with abort + spec validation). */
  probe?: (url: string) => Promise<IHttpProbe>;
  /** Injected clock (defaults to Date.now) — lets tests run without real time. */
  now?: () => number;
  /** Injected sleep (defaults to setTimeout) — no-op in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface IWaitResult {
  ok: boolean;
  /** The last failure reason (HTTP status or thrown message); "" once ok. */
  lastError: string;
  /** How many probes were attempted (≥ 1). */
  attempts: number;
}

/** The pre-flight decision: wait for the API's OpenAPI spec, and on failure return
 *  the actionable, fail-closed message the caller prints before refusing to build.
 *  Testable (inject the probe/clock via `opts`) so "unavailable endpoint blocks the
 *  build" is proven without a real server or process.exit. */
export async function preflightApi(
  url: string,
  cloneDir: string,
  opts: IWaitForOpenApiOpts = {}
): Promise<{ ok: true; attempts: number } | { ok: false; message: string }> {
  const result = await waitForOpenApi(url, opts);

  if (result.ok) {
    return { ok: true, attempts: result.attempts };
  }

  return {
    ok: false,
    message:
      `the BoringStack API is not serving its OpenAPI spec at ${url} ` +
      `(${result.lastError}).\n` +
      `  The stack must be running before a build — the UI regenerates its API ` +
      `client from this spec every gate cycle.\n` +
      `  Bring it up:  cd ${cloneDir}/infra/compose/compose && ./dev.sh up -d --build`,
  };
}

/** The IO a headless caller needs to run the pre-flight as a hard gate: two writers
 *  and a terminating `exit`. Injected so the gate decision (pass → continue, fail →
 *  exit non-zero with the actionable message) is unit-testable without a real process. */
export interface IPreflightIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  /** Terminate the process with `code`; typed `never` because it does not return. */
  exit: (code: number) => never;
}

/**
 * Run the pre-flight as a fail-closed build gate: on success, print how many probes
 * it took and return; on failure, print the actionable infra message to stderr and
 * `exit(2)` — never starting a build against an API that can't serve its spec.
 */
export async function preflightOrExit(
  url: string,
  cloneDir: string,
  io: IPreflightIo,
  opts: IWaitForOpenApiOpts = {}
): Promise<void> {
  io.writeOut(`preflight: waiting for the API at ${url}…\n`);

  const result = await preflightApi(url, cloneDir, opts);

  if (!result.ok) {
    io.writeErr(`\n✗ ${result.message}\n`);
    io.exit(2);

    return;
  }

  io.writeOut(
    `preflight: API reachable (${String(result.attempts)} probe(s))\n`
  );
}

/** Resolve the OpenAPI spec URL the gate + pre-flight use: an explicit `OPENAPI_URL`
 *  wins; otherwise default to the API's published host port. Pure + testable. */
export function resolveOpenApiUrl(
  envUrl: string | undefined,
  apiPort: number | string
): string {
  return envUrl !== undefined && envUrl.length > 0
    ? envUrl
    : `http://localhost:${String(apiPort)}/swagger/json`;
}

/** Is a parsed response body actually an OpenAPI/Swagger document generate:api can
 *  consume? A version string ALONE isn't proof — `{"openapi":"garbage"}` or a version
 *  with no `paths` still make the client generator fail, returning the harness to the
 *  very gate failure the pre-flight exists to prevent. Require the three fields every
 *  real spec (and the generator) needs: a non-empty version STRING, an `info` object,
 *  and a `paths` object (even an empty `{}` is fine). Pure + testable. */
export function isOpenApiSpec(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }

  const hasVersion =
    (typeof body.openapi === "string" && body.openapi.length > 0) ||
    (typeof body.swagger === "string" && body.swagger.length > 0);

  return hasVersion && isRecord(body.info) && isRecord(body.paths);
}

/** The real probe: abort a hung connect after `perAttemptMs`, and require the body
 *  to actually BE an OpenAPI/Swagger document — a 2xx that returns 204/HTML/garbage
 *  would still make generate:api fail, so it must not pass pre-flight. Throws a
 *  descriptive error on a 2xx-but-not-a-spec response (surfaced as the last error). */
async function realProbe(
  url: string,
  perAttemptMs: number
): Promise<IHttpProbe> {
  const res = await fetch(url, { signal: AbortSignal.timeout(perAttemptMs) });

  if (!res.ok) {
    return { ok: false, status: res.status };
  }

  const body: unknown = await res.json();

  if (!isOpenApiSpec(body)) {
    throw new Error(
      `HTTP ${String(res.status)} but the response is not a usable OpenAPI spec ` +
        `(needs a non-empty "openapi"/"swagger" version plus "info" and "paths" ` +
        `objects)`
    );
  }

  return { ok: true, status: res.status };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll an OpenAPI spec URL until it responds OK or the timeout elapses. Returns
 * ok=false with the last error (never throws), so the caller decides how to fail.
 * At least one probe always runs, even with a zero timeout.
 */
export async function waitForOpenApi(
  url: string,
  opts: IWaitForOpenApiOpts = {}
): Promise<IWaitResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const perAttemptMs = opts.perAttemptMs ?? 10_000;
  const probe = opts.probe ?? ((url) => realProbe(url, perAttemptMs));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;

  const deadline = now() + timeoutMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    let lastError: string;

    try {
      const result = await probe(url);

      if (result.ok) {
        return { ok: true, lastError: "", attempts };
      }

      lastError = `HTTP ${String(result.status)}`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (now() >= deadline) {
      return { ok: false, lastError, attempts };
    }

    await sleep(intervalMs);
  }
}
