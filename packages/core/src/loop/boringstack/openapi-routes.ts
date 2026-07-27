import { isOpenApiSpec } from "./openapi-preflight";
import { isRecord } from "../../lib/guards";

/**
 * Runtime route-presence (P1): assert the feature's CRUD routes are ACTUALLY served by
 * the running API, not merely present as a substring in the route-table source.
 *
 * The static reachability check reads `routes.ts` and looks for the resource name — a
 * proxy that #202 proved false-greens (a route that merely LOOKS mounted). This queries
 * the running server's OpenAPI spec (`/swagger/json`, public, no auth — the same spec
 * `generate:api` already consumes every cycle) and asserts the feature's paths exist in
 * it: if the resource isn't genuinely mounted, its create/list/edit/delete would 404 at
 * runtime. Observable end-state, not the source's story.
 *
 * INCONCLUSIVE (spec unreachable / not a spec) is non-blocking: a transient mid-loop blip
 * must not red a feature, and the build-start pre-flight already fail-closes a genuinely
 * down API.
 */

/** The two CRUD paths a BoringStack resource MUST serve — verified against the live spec:
 *  the collection root (list + create, TRAILING SLASH) and the by-id path (get/update/
 *  delete, literal `{id}`). */
export function expectedRoutePaths(entityKey: string): string[] {
  return [`/api/v1/${entityKey}/`, `/api/v1/${entityKey}/{id}`];
}

export interface IRoutesServed {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

/** Pure: are the feature's required CRUD paths present in the served spec's path set? */
export function checkRoutesServed(
  servedPaths: readonly string[],
  entityKey: string
): IRoutesServed {
  const served = new Set(servedPaths);
  const missing = expectedRoutePaths(entityKey).filter((p) => !served.has(p));

  return { ok: missing.length === 0, missing };
}

/** Fetches a URL and returns the parsed JSON body (injectable for tests). */
export type SpecFetcher = (url: string) => Promise<unknown>;

async function defaultFetcher(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

  if (!res.ok) {
    throw new Error(`status ${String(res.status)}`);
  }

  return res.json();
}

/**
 * Fetch the running API's OpenAPI spec and return its path keys, or null when the read is
 * INCONCLUSIVE (unreachable, non-2xx, or not a valid spec) — the caller MUST treat null as
 * non-blocking.
 */
export async function fetchServedPaths(
  url: string,
  fetcher: SpecFetcher = defaultFetcher
): Promise<string[] | null> {
  try {
    const body = await fetcher(url);

    if (!isOpenApiSpec(body) || !isRecord(body) || !isRecord(body.paths)) {
      return null;
    }

    return Object.keys(body.paths);
  } catch {
    return null; // unreachable / parse error → inconclusive, never blocks
  }
}
