/**
 * Content fingerprint for an external plugin entry and its relative import graph.
 *
 * Used to freeze plugin content at load time: a workspace-local plugin that is
 * edited mid-session must hard-fail the gate rather than quietly weaken its rules
 * under the same pack id (audit F19).
 *
 * Only relative imports are followed (the workspace-controlled surface). Bare
 * package imports are not walked — those live outside the editable tree.
 */

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

/** Cap how many source files a single plugin graph may contribute. */
const MAX_FILES = 64;
/** Cap total bytes hashed for one plugin (keeps a hostile tree from stalling load). */
const MAX_BYTES = 2 * 1024 * 1024;

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

/** Relative import/require/export-from specs only (`.` or `..`). The bare
 *  `import "./x"` form binds no names, so it never reaches the `from` branch —
 *  and a side-effect module is exactly where content that changes rule behavior
 *  without changing an export can hide. */
const RELATIVE_SPEC =
  /(?:from\s+|import\s*\(|require\s*\(|import\s+)\s*['"](\.[^'"]+)['"]/gu;

function isUnderRoot(file: string, root: string): boolean {
  const rel = relative(root, file);

  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Candidate paths for a bare relative specifier (with and without extensions). */
function candidatePaths(fromFile: string, spec: string): string[] {
  const base = resolve(dirname(fromFile), spec);
  const out: string[] = [];

  if (CODE_EXT.has(extname(base))) {
    out.push(base);
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

function collectRelativeSpecs(source: string): string[] {
  const specs: string[] = [];

  for (const match of source.matchAll(RELATIVE_SPEC)) {
    const spec = match[1];

    if (spec !== undefined && spec.length > 0) {
      specs.push(spec);
    }
  }

  return specs;
}

/**
 * SHA-256 hex over the plugin entry and every reachable relative import under
 * the entry's directory tree. Paths are mixed into the digest so a rename that
 * preserves bytes still counts as a change.
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

  while (queue.length > 0 && files < MAX_FILES && bytes < MAX_BYTES) {
    const next = queue.shift();

    if (next === undefined) {
      break;
    }

    const file = normalize(next);

    if (seen.has(file) || !isUnderRoot(file, root)) {
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
    // Stable path key relative to the plugin root so absolute cwd moves don't
    // churn the fingerprint.
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(source);
    hash.update("\0");

    for (const spec of collectRelativeSpecs(source)) {
      for (const candidate of candidatePaths(file, spec)) {
        if (!seen.has(normalize(candidate)) && isUnderRoot(candidate, root)) {
          queue.push(candidate);
        }
      }
    }
  }

  // The loop stops on an empty queue OR a cap, so leftovers mean a cap cut the
  // walk short. Hashing that prefix would leave every file past the cut unpinned
  // and freely editable under the same digest — fail closed instead of pretending
  // the graph is frozen.
  if (queue.length > 0) {
    throw new Error(
      `tsforge: plugin '${entry}' exceeds the freeze limit (${String(MAX_FILES)} files / ${String(MAX_BYTES)} bytes) — its content cannot be pinned. Split the plugin or ship it as a package.`
    );
  }

  hash.update(`files:${String(files)}`);

  return hash.digest("hex");
}
