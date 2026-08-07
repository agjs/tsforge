/**
 * Content fingerprint for an external plugin entry and its relative import graph.
 *
 * Used to freeze plugin content at load time: a workspace-local plugin that is
 * edited mid-session must hard-fail the gate rather than quietly weaken its rules
 * under the same pack id (audit F19).
 *
 * The graph is the workspace-EDITABLE surface, wherever it sits: relative
 * imports (including ones above the entry's own directory) and package
 * specifiers that resolve back into the repo, as a linked workspace package or
 * a path alias does. Installed dependencies under `node_modules` are excluded —
 * not the surface this pins, and walking them would drag in the whole tree.
 *
 * Imported data files count too — `import severities from "./severities.json"`
 * decides what a pack enforces as much as any rule module does.
 *
 * KNOWN LIMITS, both needing more than an import graph to close:
 * - A file the plugin READS at runtime (`readFile("./severities.json")`) is
 *   invisible here; nothing in the source says which paths a plugin will open.
 * - Content swapped between the load hash and the post-import re-hash is
 *   executed, and restoring the original bytes before that re-hash leaves a
 *   matching digest. Catching that needs the import to read the same bytes the
 *   hash did, which the module loader gives no way to arrange.
 */

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import {
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

/** Bounds on the walk. Exceeding one is a hard failure, never a truncation — a
 *  prefix of a graph is not a freeze. They are set where no plausible rule pack
 *  reaches them, so the only thing that should ever trip them is a tree built to
 *  stall load. `maxQueue` bounds the SPECULATIVE work: `candidatePaths` queues up
 *  to 16 spellings per specifier, so without it a file full of imports fans out
 *  far past anything the file/byte caps would catch. */
export const FREEZE_LIMITS = {
  maxFiles: 512,
  maxBytes: 8 * 1024 * 1024,
  maxQueue: 20_000,
} as const;

const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

/** Every import/require/export-from specifier. The bare `import "./x"` form
 *  binds no names, so it never reaches the `from` branch — and a side-effect
 *  module is exactly where content that changes rule behavior without changing
 *  an export can hide. Package specifiers are captured too: in a monorepo a
 *  linked workspace package or a path alias is imported BY NAME and still lives
 *  in the repo, as editable as the plugin file itself. */
const SPEC =
  /(?:from\s+|import\s*\(|require\s*\(|import\s+)\s*['"]([^'"]+)['"]/gu;

/** The TypeScript sources an emitted-extension specifier can stand for. */
const TS_FOR_EMITTED = new Map<string, readonly string[]>([
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
]);

/** Fail the walk when a bound is crossed. A graph too big to pin is not a graph
 *  that may be pinned partially: everything past the cut would be editable under
 *  an unchanged digest. `exceeded` names WHICH bound, since the fix for a file
 *  count is not the fix for a fan-out of unresolvable specifiers. */
function limit(withinBounds: boolean, entry: string, exceeded: string): void {
  if (!withinBounds) {
    throw new Error(
      `tsforge: plugin '${entry}' exceeds the freeze limit (${exceeded}) — its content cannot be pinned. Split the plugin or ship it as a package.`
    );
  }
}

/**
 * The file a PACKAGE specifier resolves to, when that file is workspace source.
 *
 * A linked workspace package resolves through a `node_modules` symlink back into
 * the repo, so the real path is what decides: outside `node_modules` it is code
 * the developer edits (and the plugin executes), and it belongs in the freeze.
 * Inside `node_modules` it is an installed dependency — not the editable surface
 * this pins, and walking it would drag the whole dependency tree in.
 */
async function workspaceSourceFor(
  fromFile: string,
  spec: string
): Promise<string | undefined> {
  if (spec.startsWith("node:") || spec.startsWith("bun:")) {
    return undefined;
  }

  try {
    const real = await realpath(Bun.resolveSync(spec, dirname(fromFile)));

    return real.includes(`${sep}node_modules${sep}`) ? undefined : real;
  } catch {
    // Unresolvable (a type-only package, an alias this process can't see) —
    // nothing to hash, and a resolution failure here must not fail the walk.
    return undefined;
  }
}

/** Candidate paths for a relative specifier (with and without extensions). */
function candidatePaths(fromFile: string, spec: string): string[] {
  const base = resolve(dirname(fromFile), spec);
  const out: string[] = [];

  // A specifier that already names a file — `./rules.ts` or `./severities.json`
  // — resolves to that file. Only an EXTENSIONLESS specifier needs the spellings
  // guessed: speculating code extensions for `./severities.json` produces
  // `severities.json.ts` and friends, none of which exist, dropping a plugin's
  // own config out of the graph.
  //
  // `.js` is the exception. Under NodeNext, TypeScript sources import each other
  // by the extension of the emitted file, so `./dep.js` is how a plugin refers
  // to `dep.ts` and no `.js` file ever exists — treating it as literal-only
  // leaves the real source unpinned.
  if (extname(base).length > 0) {
    out.push(base);

    const ts = TS_FOR_EMITTED.get(extname(base));

    if (ts !== undefined) {
      for (const ext of ts) {
        out.push(`${base.slice(0, -extname(base).length)}${ext}`);
      }
    }
  } else {
    for (const ext of CODE_EXT) {
      out.push(`${base}${ext}`);
    }

    for (const ext of CODE_EXT) {
      out.push(join(base, `index${ext}`));
    }
  }

  return out;
}

function collectSpecs(source: string): string[] {
  const specs: string[] = [];

  for (const match of source.matchAll(SPEC)) {
    const spec = match[1];

    if (spec !== undefined && spec.length > 0) {
      specs.push(spec);
    }
  }

  return specs;
}

/** Queue every file this source imports that belongs to the editable surface.
 *  A relative specifier queues its candidate spellings (at most one exists); a
 *  package specifier queues the workspace file it resolves to, if any. */
async function enqueueImports(
  file: string,
  source: string,
  seen: ReadonlySet<string>,
  queue: string[],
  entry: string
): Promise<void> {
  for (const spec of collectSpecs(source)) {
    const candidates = spec.startsWith(".")
      ? candidatePaths(file, spec)
      : [await workspaceSourceFor(file, spec)];

    for (const candidate of candidates) {
      if (candidate !== undefined && !seen.has(normalize(candidate))) {
        queue.push(candidate);
      }
    }

    // Checked per specifier, not once per file: ONE file holds as many imports
    // as someone cares to write, each queuing up to 16 spellings and costing a
    // resolve, so a bound applied after the whole file has been walked is a
    // bound that has already been exceeded.
    limit(
      queue.length <= FREEZE_LIMITS.maxQueue,
      entry,
      `${String(FREEZE_LIMITS.maxQueue)} speculative paths queued`
    );
  }
}

/**
 * SHA-256 hex over the plugin entry and every reachable workspace source file it
 * imports. Paths are mixed into the digest so a rename that preserves bytes
 * still counts as a change.
 */
export async function fingerprintPluginEntry(
  entryPath: string
): Promise<string> {
  // realpath, not the lexical path: Node resolves a plugin's relative imports
  // against the entry's REAL directory, so a symlinked entry walked lexically
  // finds none of its dependencies and pins the entry file alone. It also makes
  // an unreadable entry fail HERE — a digest over zero files is a constant, so
  // every unpinnable plugin would share one and never register drift.
  const entry = await realpath(normalize(resolve(entryPath))).catch(
    () => undefined
  );

  if (entry === undefined) {
    throw new Error(
      `tsforge: cannot fingerprint plugin entry '${entryPath}' — refusing to register a plugin whose content cannot be pinned.`
    );
  }

  const root = dirname(entry);
  const hash = createHash("sha256");
  const queue: string[] = [entry];
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;

  while (queue.length > 0) {
    const next = queue.shift();

    if (next === undefined) {
      break;
    }

    const file = normalize(next);

    if (seen.has(file)) {
      continue;
    }

    seen.add(file);

    let source: string;

    try {
      source = await readFile(file, "utf8");
    } catch {
      // Only extension/index candidates reach here — `candidatePaths` speculates
      // several spellings per specifier and at most one exists. The entry itself
      // was proven readable above.
      continue;
    }

    files += 1;
    bytes += Buffer.byteLength(source, "utf8");
    // Counted AFTER a successful read, so the speculative spellings still queued
    // never push a graph over the limit — the caps bound real content, and a
    // graph that fits is never refused for the phantoms trailing behind it.
    limit(
      files <= FREEZE_LIMITS.maxFiles && bytes <= FREEZE_LIMITS.maxBytes,
      entry,
      `${String(FREEZE_LIMITS.maxFiles)} files / ${String(FREEZE_LIMITS.maxBytes)} bytes`
    );

    // Stable path key relative to the plugin root so absolute cwd moves don't
    // churn the fingerprint.
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(source);
    hash.update("\0");

    await enqueueImports(file, source, seen, queue, entry);
  }

  hash.update(`files:${String(files)}`);

  return hash.digest("hex");
}
