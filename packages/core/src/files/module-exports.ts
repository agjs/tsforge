import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";

/**
 * Resolve a TS import specifier seen in `fromFileAbs` to an ABSOLUTE module file
 * path, trying the common extensions + an `/index` barrel. Returns null for
 * bare/package imports (no `./`, `../`, or `@/`) or when nothing resolves. The
 * `@/` alias maps to `<cwd>/src/` — the convention the web scaffold sets in its
 * tsconfig `paths`.
 */
export function resolveLocalModule(
  fromFileAbs: string,
  spec: string,
  cwd: string
): string | null {
  let base: string;

  if (spec.startsWith("@/")) {
    base = join(cwd, "src", spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = join(dirname(fromFileAbs), spec);
  } else {
    return null;
  }

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];

  for (const c of candidates) {
    if ((c.endsWith(".ts") || c.endsWith(".tsx")) && existsSync(c)) {
      return c;
    }
  }

  return null;
}

const EXPORT_DECL =
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gu;
const EXPORT_LIST = /\bexport\s*(?:type\s*)?\{([^}]*)\}/gu;

/**
 * Best-effort list of the identifier names a TS module EXPORTS — named
 * declarations (`export const/function/class/type/interface/enum X`) plus
 * `export { a, b as c }` lists (the exposed name `c` is taken). A tolerant regex
 * scan, so it still works on a partially-written or not-yet-parsing file. Returns
 * a de-duplicated list in source order; [] if the file can't be read.
 */
export function readExportedNames(absFile: string): string[] {
  let text: string;

  try {
    text = readFileSync(absFile, "utf8");
  } catch {
    return [];
  }

  const names = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = EXPORT_DECL.exec(text)) !== null) {
    if (m[1] !== undefined) {
      names.add(m[1]);
    }
  }

  while ((m = EXPORT_LIST.exec(text)) !== null) {
    for (const raw of (m[1] ?? "").split(",")) {
      const part = raw.trim();

      if (part.length === 0) {
        continue;
      }

      // `a as b` exposes `b`; a bare `a` exposes `a`.
      const exposed = part.includes(" as ") ? part.split(/ as /u)[1] : part;
      const name = exposed?.trim().replace(/^type\s+/u, "");

      if (name !== undefined && /^[A-Za-z_$][\w$]*$/u.test(name)) {
        names.add(name);
      }
    }
  }

  return [...names];
}

const MAX_EXPORTS_SHOWN = 12;

/**
 * For a `has no exported member` diagnostic (TS2305 / TS2724) on a LOCAL module,
 * a one-line hint naming what that module ACTUALLY exports — so the model stops
 * guessing import names and thrashing across turns. Empty string when the code
 * isn't an import-member error, the module is a package, or it exports nothing
 * resolvable.
 */
export function missingExportHint(
  code: number,
  message: string,
  fromFileAbs: string,
  cwd: string
): string {
  if (code !== 2305 && code !== 2724) {
    return "";
  }

  // TS2305: Module '"@/x"' has no exported member 'Foo'.
  // TS2724: '"@/x"' has no exported member named 'Foo'. Did you mean 'Bar'?
  const spec = /'"([^"]+)"'\s+has no exported member/u.exec(message)?.[1];

  if (spec === undefined) {
    return "";
  }

  const resolved = resolveLocalModule(fromFileAbs, spec, cwd);

  if (resolved === null) {
    return "";
  }

  const names = readExportedNames(resolved);

  if (names.length === 0) {
    return "";
  }

  const shown = names.slice(0, MAX_EXPORTS_SHOWN).join(", ");
  const more =
    names.length > MAX_EXPORTS_SHOWN
      ? `, …(+${String(names.length - MAX_EXPORTS_SHOWN)} more)`
      : "";

  return ` [${spec} exports: ${shown}${more}]`;
}

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".tsforge",
  ".git",
]);

/** Walk a directory collecting `.ts`/`.tsx` source files (skipping vendored/build
 *  dirs and `.d.ts`). Best-effort: unreadable dirs are skipped. */
function collectTsFiles(root: string): string[] {
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>;

    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) {
          walk(join(dir, entry.name));
        }
      } else if (
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        out.push(join(dir, entry.name));
      }
    }
  };

  walk(root);

  return out;
}

/** The `@/…` import specifier the web scaffold uses for a file under `<cwd>/src`
 *  (e.g. `<cwd>/src/features/users/users.types.ts` → `@/features/users/users.types`),
 *  dropping the extension and a trailing `/index`. Null if not under `src/`. */
function toAliasSpecifier(absFile: string, cwd: string): string | null {
  const rel = relative(join(cwd, "src"), absFile);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }

  const noExt = rel.replace(/\\/gu, "/").replace(/\.tsx?$/u, "");

  return `@/${noExt.replace(/\/index$/u, "")}`;
}

/**
 * Index every exported name in `<cwd>/src` → the `@/` module specifier(s) that
 * export it. Built fresh (files change mid-build, so a cached index would mislead)
 * but only on demand — see `unresolvedNameHint`. Scoped to `src/` since that's the
 * aliased layout where the `Cannot find name` thrash was observed; a flat/no-`src`
 * project simply yields an empty index (no hint, no harm).
 */
export function buildExportIndex(cwd: string): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const abs of collectTsFiles(join(cwd, "src"))) {
    const spec = toAliasSpecifier(abs, cwd);

    if (spec === null) {
      continue;
    }

    for (const name of readExportedNames(abs)) {
      const specs = index.get(name) ?? [];

      if (!specs.includes(spec)) {
        specs.push(spec);
      }

      index.set(name, specs);
    }
  }

  return index;
}

/**
 * For a `Cannot find name 'X'` diagnostic (TS2304 — the symbol isn't imported or
 * defined at all), a hint naming the module that EXPORTS `X` and the import to add
 * — so the model stops re-editing the wrong lines for turns on end (observed:
 * `IUser` not found, ~8 turns). High precision: only fires when `X` is actually an
 * export somewhere in the project. `self` is the importing file's own specifier, so
 * a symbol the file exports itself isn't suggested as a self-import.
 */
export function unresolvedNameHint(
  code: number,
  message: string,
  index: Map<string, string[]>,
  self: string | null
): string {
  if (code !== 2304) {
    return "";
  }

  const name = /Cannot find name '([^']+)'/u.exec(message)?.[1];

  if (name === undefined) {
    return "";
  }

  const specs = (index.get(name) ?? []).filter((s) => s !== self);

  if (specs.length === 0) {
    return "";
  }

  if (specs.length === 1) {
    return ` [add: import { ${name} } from "${specs[0] ?? ""}"]`;
  }

  return ` [${name} is exported by: ${specs.slice(0, 3).join(", ")}]`;
}

/** The importing file's own `@/` specifier (for self-import exclusion), or null. */
export function selfSpecifier(absFile: string, cwd: string): string | null {
  return toAliasSpecifier(absFile, cwd);
}
