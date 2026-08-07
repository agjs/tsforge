import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { IEdge, IExternalImport } from "./architecture.types";

/** The bucket id for loose `src/*.ts` files that belong to no subsystem directory. */
export const ROOT_ID = "(root)";

/** Extensions tried when resolving an extensionless relative specifier, in order. */
const EXTENSIONS = [".ts", ".tsx", ".d.ts"] as const;

/**
 * Resolve a relative import specifier to the file it names.
 *
 * Mirrors the resolution order the bundler uses: `X.ts` wins over `X/index.ts`.
 * That order is not cosmetic here — `src/cli.ts` and `src/cli/` BOTH exist, so a
 * specifier of `../cli` is the root file, not the directory. Resolving it the other
 * way silently reassigns every `cli.ts` import to the `cli` subsystem.
 *
 * Returns null when nothing on disk matches (a specifier into a deleted module).
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string
): string | null {
  const base = resolve(dirname(fromFile), specifier);

  for (const ext of EXTENSIONS) {
    const withExt = base + ext;

    if (existsSync(withExt) && statSync(withExt).isFile()) {
      return withExt;
    }
  }

  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const ext of EXTENSIONS) {
      const index = join(base, "index" + ext);

      if (existsSync(index) && statSync(index).isFile()) {
        return index;
      }
    }
  }

  return null;
}

/**
 * Which subsystem owns a resolved file: its first path segment under `srcRoot`, or
 * `(root)` for a file sitting directly in `src/`. Null when the file is outside
 * `srcRoot` — a real import that simply leaves the mapped tree.
 *
 * The single-segment case is the one that bites: `../lsp` resolves to the DIRECTORY
 * `src/lsp`, whose relative path has one segment. Treating that as a root file hides
 * the whole subsystem and inflates `(root)`'s fan-in with every directory import.
 */
export function subsystemOf(srcRoot: string, file: string): string | null {
  const rel = relative(srcRoot, file);

  if (rel === "" || rel.startsWith("..")) {
    return null;
  }

  const segments = rel.split(sep);
  const first = segments[0];

  if (segments.length <= 1 || first === undefined) {
    return ROOT_ID;
  }

  return first;
}

/**
 * Same, for a file the caller knows is inside the tree (it came from the scan).
 * Throws otherwise, because that would mean the scan and the resolver disagree.
 */
function ownerOfScanned(srcRoot: string, file: string): string {
  const id = subsystemOf(srcRoot, file);

  if (id === null) {
    throw new Error(
      `architecture: scanned file sits outside src root: ${file}`
    );
  }

  return id;
}

/** 1-based line number for a character offset. */
function lineOf(text: string, pos: number): number {
  let line = 1;

  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }

  return line;
}

/**
 * Every cross-subsystem import edge under `srcRoot`, plus imports that leave it.
 *
 * Imports are read with `ts.preProcessFile`, never by scanning the file text. The
 * codebase stores snippets of code it GENERATES in string constants (see
 * `loop/boringstack/wire-resource.ts`), and a text scan cannot tell those apart from
 * this file's own imports — it invents subsystems that were never here.
 *
 * Type-only imports are kept, not filtered out. `preProcessFile` reports them like any
 * other import declaration, and an `import type` still couples two subsystems — which is
 * exactly why the repo's own boundary rule uses `@typescript-eslint/no-restricted-imports`
 * (the variant that catches the type form) rather than the base ESLint rule. Do not add
 * a filter here to "count only runtime deps"; it would erase real architectural coupling.
 *
 * Not followed: dynamic `import()`, `createRequire`, and path aliases (none are used
 * for cross-subsystem imports here). Bare package specifiers are skipped by design.
 */
export async function analyzeImports(
  srcRoot: string,
  files: readonly string[],
  packageRoot: string = resolve(srcRoot, "..")
): Promise<{ edges: IEdge[]; externals: IExternalImport[] }> {
  const seen = new Set<string>();
  const edges: IEdge[] = [];
  const externals: IExternalImport[] = [];

  for (const file of files) {
    const from = ownerOfScanned(srcRoot, file);
    const text = await Bun.file(file).text();
    const info = ts.preProcessFile(text, true, true);

    for (const ref of info.importedFiles) {
      if (!ref.fileName.startsWith(".")) {
        continue;
      }

      const target = resolveSpecifier(file, ref.fileName);

      if (target === null) {
        continue;
      }

      const witness = `${relative(srcRoot, file)}:${lineOf(text, ref.pos)}`;
      const to = subsystemOf(srcRoot, target);

      if (to === null) {
        externals.push({
          from,
          witness,
          target: relative(packageRoot, target),
        });
        continue;
      }

      if (to === from) {
        continue;
      }

      const key = `${from} ${to}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      edges.push({ from, to, witness, specifier: ref.fileName });
    }
  }

  return { edges, externals };
}
