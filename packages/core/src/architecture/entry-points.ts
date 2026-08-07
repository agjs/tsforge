import { relative } from "node:path";
import ts from "typescript";
import type { IEntryPoint, ISeam } from "./architecture.types";

/** The injected interfaces an adapter fills in to plug into the core loop. */
export const SEAM_NAMES = [
  "IStackAdapter",
  "IConventionProvider",
  "IPlanSchema",
  "IGate",
  "IProductPlan",
] as const;

/**
 * A CLI mode is an async function returning an exit code. Matching that SIGNATURE
 * rather than a `*Mode` name is what keeps the list honest — the codebase is full of
 * predicates like `isPolicyMode` and `wizardOwnsRawMode` that share the suffix and
 * are not commands, while the default one-shot path (`runOnce`) has no suffix at all.
 */
function isModeSignature(node: ts.FunctionDeclaration): boolean {
  const isAsync =
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;

  if (!isAsync) {
    return false;
  }

  const returns = node.type;

  if (returns === undefined || !ts.isTypeReferenceNode(returns)) {
    return false;
  }

  if (returns.typeName.getText() !== "Promise") {
    return false;
  }

  return returns.typeArguments?.[0]?.kind === ts.SyntaxKind.NumberKeyword;
}

function sourceFile(text: string, path: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

function lineAt(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** True for `cli.ts` and anything under `cli/` — where commands are allowed to live. */
function isCliSource(rel: string): boolean {
  return rel === "cli.ts" || rel.startsWith("cli" + "/");
}

/**
 * Every CLI command function: async, returns an exit code, declared under the CLI.
 *
 * Found by declaration shape rather than by tracing calls out of `main()`: the
 * dispatch is a chain of early returns, so a call-trace would silently lose a mode
 * the day someone reorders it. A rename still shows up here, which is the point.
 */
export function findEntryPoints(
  srcRoot: string,
  sources: ReadonlyMap<string, string>
): IEntryPoint[] {
  const found: IEntryPoint[] = [];

  for (const [path, text] of sources) {
    const rel = relative(srcRoot, path);

    if (!isCliSource(rel)) {
      continue;
    }

    const file = sourceFile(text, path);

    ts.forEachChild(file, (node) => {
      if (!ts.isFunctionDeclaration(node) || node.name === undefined) {
        return;
      }

      if (!isModeSignature(node)) {
        return;
      }

      found.push({ fn: node.name.text, at: `${rel}:${lineAt(file, node)}` });
    });
  }

  return found.sort((a, b) => a.fn.localeCompare(b.fn));
}

/**
 * Where each adapter seam is declared and which files fill it in.
 *
 * Throws when a named seam has no declaration. A seam that quietly disappears would
 * otherwise leave the architecture page describing a contract the code no longer has.
 */
export function findSeams(
  srcRoot: string,
  sources: ReadonlyMap<string, string>
): ISeam[] {
  const declaredAt = new Map<string, string>();
  const implementors = new Map<string, Set<string>>();

  for (const [path, text] of sources) {
    const rel = relative(srcRoot, path);
    const file = sourceFile(text, path);

    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && isSeam(node.name.text)) {
        declaredAt.set(node.name.text, `${rel}:${lineAt(file, node)}`);
      }

      ts.forEachChild(node, visit);
    };

    visit(file);

    for (const seam of SEAM_NAMES) {
      if (!text.includes(seam)) {
        continue;
      }

      const set = implementors.get(seam) ?? new Set<string>();

      set.add(rel);
      implementors.set(seam, set);
    }
  }

  return SEAM_NAMES.map((name) => {
    const at = declaredAt.get(name);

    if (at === undefined) {
      throw new Error(
        `architecture: seam ${name} has no interface declaration under src/ — ` +
          `remove it from SEAM_NAMES or restore the interface`
      );
    }

    const users = [...(implementors.get(name) ?? new Set<string>())]
      .filter((rel) => !at.startsWith(rel + ":"))
      .sort();

    return { name, declaredAt: at, implementors: users };
  });
}

/** Widened to `string` so an arbitrary interface name can be tested against the tuple. */
const SEAM_SET: ReadonlySet<string> = new Set(SEAM_NAMES);

function isSeam(name: string): boolean {
  return SEAM_SET.has(name);
}
