import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  isComponentDeclaration,
  isInShadcnUi,
  isRouteFile,
  isStoryFile,
  isTestFile,
  unwrapExport,
} from "../utils";

export const RULE_NAME = "component-file-purity";

type MessageIds = "inlineType" | "inlineConstant" | "inlineHelper";

/** Map an offending top-level declaration to the message that tells the model
 *  where it belongs. Returns null for declarations that are allowed to sit
 *  beside a component (none today — the component itself is filtered earlier). */
function messageForDeclaration(node: TSESTree.Node): MessageIds | null {
  switch (node.type) {
    case AST_NODE_TYPES.TSInterfaceDeclaration:
    case AST_NODE_TYPES.TSTypeAliasDeclaration:
    case AST_NODE_TYPES.TSEnumDeclaration:
      return "inlineType";
    case AST_NODE_TYPES.VariableDeclaration:
      return "inlineConstant";
    case AST_NODE_TYPES.FunctionDeclaration:
      return "inlineHelper";
    default:
      return null;
  }
}

export const componentFilePurityRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "A component .tsx contains only imports and the component itself — types go to <feature>.types.ts, constants to <feature>.constants.ts, helpers to src/lib",
    },
    schema: [],
    messages: {
      inlineType:
        "No inline types in a component file — move this to <feature>.types.ts (or src/shared/shared.types.ts if cross-feature) and import it.",
      inlineConstant:
        "No inline constants in a component file — move this to <feature>.constants.ts and import it. A component file holds only imports and the component.",
      inlineHelper:
        "No inline helper functions in a component file — move pure helpers (formatters, etc.) to src/lib and import them. A component file holds only imports and the component.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename;

    if (!filename.endsWith(".tsx")) {
      return {};
    }

    // Primitives (cva variant consts) and route shells (`const Route = …`)
    // legitimately carry non-component module declarations. Tests/stories too.
    if (
      isInShadcnUi(filename) ||
      isRouteFile(filename) ||
      isStoryFile(filename) ||
      isTestFile(filename)
    ) {
      return {};
    }

    return {
      Program(program) {
        const unwrapped = program.body.map((s) => ({
          stmt: s,
          decl: unwrapExport(s),
        }));

        // Only enforce purity on files that actually define a component; a .tsx
        // with no component isn't a "component file" this rule governs.
        const hasComponent = unwrapped.some((u) =>
          isComponentDeclaration(u.decl)
        );

        if (!hasComponent) {
          return;
        }

        for (const { decl } of unwrapped) {
          if (isComponentDeclaration(decl)) {
            continue;
          }

          const messageId = messageForDeclaration(decl);

          if (messageId === null) {
            continue;
          }

          context.report({ node: decl, messageId });
        }
      },
    };
  },
});
