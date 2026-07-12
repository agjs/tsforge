import { dirname, join } from "node:path";
import type { TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-self-import";

type MessageIds = "selfImport";

/** Trailing TS/JS extension (incl. .mts/.cts/.tsx) to strip when comparing paths. */
const STRIP_EXT = /\.[cm]?[tj]sx?$/u;

type WithSource =
  | TSESTree.ImportDeclaration
  | TSESTree.ExportNamedDeclaration
  | TSESTree.ExportAllDeclaration;

/**
 * Disallow a module importing (or re-exporting) from ITSELF. The model sometimes
 * writes `import { Foo } from "./Foo"` inside `Foo.tsx` — a circular self-reference
 * whose named binding doesn't exist, which surfaces only as a cryptic Rollup build
 * error ("Foo is not exported by Foo, imported by Foo") it then can't fix. Catch it
 * at lint time with a clear message: define the binding here, don't import it.
 */
export const noSelfImportRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a module importing or re-exporting from itself (a circular self-reference whose binding doesn't exist).",
    },
    schema: [],
    messages: {
      selfImport:
        "'{{source}}' resolves to THIS file — a module cannot import or re-export from itself (it bundles to a circular self-reference that breaks the build). Fix: define/keep the binding directly in this file. If this is a barrel `index.ts` sitting beside an `index.tsx` of the same folder, DELETE this file — the `.tsx` component is already the module entry (import it via the folder path, e.g. `@/views/Foo`).",
    },
  },
  defaultOptions: [],
  create(context) {
    const self = context.filename.replace(STRIP_EXT, "");

    const check = (node: WithSource): void => {
      const source = node.source?.value;

      if (
        typeof source !== "string" ||
        (!source.startsWith("./") &&
          !source.startsWith("../") &&
          source !== ".")
      ) {
        return;
      }

      // `join` (not `resolve`) so the result keeps the SAME base as
      // `context.filename` — relative stays relative, absolute stays absolute —
      // making the equality check robust to how eslint passes the path.
      const resolved = join(dirname(context.filename), source).replace(
        STRIP_EXT,
        ""
      );

      // Direct (`./Foo` in Foo.tsx) or barrel (`.` / `./` in index.tsx) self-import.
      // `join` (not `${resolved}/index`) so the barrel check uses the platform
      // separator — `resolved`/`self` are `join`-based, so `\` on Windows.
      if (resolved === self || join(resolved, "index") === self) {
        context.report({
          node: node.source ?? node,
          messageId: "selfImport",
          data: { source },
        });
      }
    };

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: (node): void => {
        if (node.source) {
          check(node);
        }
      },
      ExportAllDeclaration: check,
    };
  },
});
