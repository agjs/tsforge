/**
 * Resolve an in-project EXEMPLAR for a blocked rule: the file that already does
 * it right. When a rule rejects a common pattern (bare `new Date()`, say), the
 * doc alone tells the model what shape to write, but not that the project
 * already contains a conforming util — so it searched for one by hand (self-eval
 * blocker seed-6). This resolves the doc's `exemplar` spec against the USER'S
 * project and renders a concrete pointer, or nothing: a pointer is only ever a
 * real, existing path — never invented, never tsforge-repo-relative.
 */
import { join, relative } from "node:path";
import { loadMap } from "../../codebase";
import type { ErrorSet } from "../../validate";
import { ruleDoc } from "./rule-docs";

const MAX_GLOB_CANDIDATES = 20;
const MAX_CANDIDATE_BYTES = 128 * 1024;

interface IExemplarHit {
  /** cwd-relative, forward slashes — safe to name in model-facing text. */
  path: string;
  /** The exported symbol that proved the file conforms. */
  symbol: string;
}

/**
 * Session-lifetime cache keyed `cwd\0rule`, so one settled path renders on
 * every settle (message text stays stable for the KV-cache prefix) and misses
 * aren't re-scanned each red. Positive hits are re-checked for existence on
 * read, so a deleted exemplar drops out instead of dangling.
 */
const cache = new Map<string, IExemplarHit | null>();

/** Test seam: the cache is module-global and must not leak across test cases. */
export function clearExemplarCache(): void {
  cache.clear();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a top-level `export const/function/class <symbol>` declaration. */
function exportPattern(symbols: readonly string[]): RegExp {
  const alt = symbols.map(escapeRegExp).join("|");

  return new RegExp(
    `^export\\s+(?:async\\s+)?(?:const|function|class)\\s+(${alt})\\b`,
    "m"
  );
}

function isExcludedPath(rel: string): boolean {
  return rel
    .split("/")
    .some((part) => part === "node_modules" || part.startsWith("."));
}

/** Prefer the shortest path (closest to the root); lexicographic tie-break. */
function betterHit(a: IExemplarHit | null, b: IExemplarHit): IExemplarHit {
  if (a === null) {
    return b;
  }

  if (b.path.length !== a.path.length) {
    return b.path.length < a.path.length ? b : a;
  }

  return b.path < a.path ? b : a;
}

async function findViaWorkspaceMap(
  cwd: string,
  symbols: readonly string[],
  fileGlobs: readonly string[]
): Promise<IExemplarHit | null> {
  const map = await loadMap(cwd);

  if (map === null) {
    return null;
  }

  const globs = fileGlobs.map((g) => new Bun.Glob(g));
  let best: IExemplarHit | null = null;

  for (const mod of Object.values(map.modules)) {
    if (isExcludedPath(mod.path) || !globs.some((g) => g.match(mod.path))) {
      continue;
    }

    const symbol = symbols.find((s) => mod.exports.includes(s));

    if (symbol !== undefined) {
      best = betterHit(best, { path: mod.path, symbol });
    }
  }

  return best;
}

async function findViaGlobScan(
  cwd: string,
  symbols: readonly string[],
  fileGlobs: readonly string[]
): Promise<IExemplarHit | null> {
  const pattern = exportPattern(symbols);
  let best: IExemplarHit | null = null;

  for (const glob of fileGlobs) {
    let seen = 0;

    for await (const rel of new Bun.Glob(glob).scan({ cwd })) {
      const norm = rel.replaceAll("\\", "/");

      if (isExcludedPath(norm)) {
        continue;
      }

      seen += 1;

      if (seen > MAX_GLOB_CANDIDATES) {
        break;
      }

      const file = Bun.file(join(cwd, norm));

      if (file.size > MAX_CANDIDATE_BYTES) {
        continue;
      }

      const match = pattern.exec(await file.text());
      const symbol = match?.[1];

      if (symbol !== undefined) {
        best = betterHit(best, { path: norm, symbol });
      }
    }
  }

  return best;
}

async function resolveOne(
  cwd: string,
  rule: string
): Promise<IExemplarHit | null> {
  const spec = ruleDoc(rule)?.exemplar;

  if (spec === undefined) {
    return null;
  }

  const key = `${cwd}\u0000${rule}`;
  const cached = cache.get(key);

  if (cached !== undefined) {
    if (cached === null || (await Bun.file(join(cwd, cached.path)).exists())) {
      return cached;
    }

    cache.delete(key);
  }

  const hit =
    (await findViaWorkspaceMap(cwd, spec.symbols, spec.fileGlobs)) ??
    (await findViaGlobScan(cwd, spec.symbols, spec.fileGlobs));

  // A map hit can name a since-deleted file; only an existing path may render.
  const verified =
    hit !== null && (await Bun.file(join(cwd, hit.path)).exists())
      ? hit
      : null;

  cache.set(key, verified);

  return verified;
}

/**
 * Resolve exemplar pointers for every distinct rule in the error set whose doc
 * carries an `exemplar` spec. Returns rule → rendered pointer; rules with no
 * spec or no conforming file are simply absent (silent omission — a "no example
 * found" line would only add noise).
 */
export async function resolveExemplars(
  errors: ErrorSet,
  cwd: string
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();

  for (const e of errors) {
    if (e.rule === undefined || out.has(e.rule)) {
      continue;
    }

    const hit = await resolveOne(cwd, e.rule);

    if (hit !== null) {
      const rel = relative(cwd, join(cwd, hit.path)).replaceAll("\\", "/");
      out.set(e.rule, `${rel} (exports ${hit.symbol}())`);
    }
  }

  return out;
}
