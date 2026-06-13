import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { hasDirective, isAppRouterFile } from "../utils";

export const RULE_NAME = "server-only-modules-import-server-only";

export interface IServerOnlyModulesImportServerOnlyOptions {
  readonly serverOnlyModule?: string;
}

type RuleOptions = [IServerOnlyModulesImportServerOnlyOptions];
type MessageIds = "missingServerOnlyImport";

const DEFAULT_SERVER_ONLY_MODULE = "server-only";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    serverOnlyModule: { type: "string", minLength: 1 },
  },
};

function hasServerOnlyImport(
  program: TSESTree.Program,
  moduleName: string
): boolean {
  for (const stmt of program.body) {
    if (stmt.type !== AST_NODE_TYPES.ImportDeclaration) {
      continue;
    }

    if (stmt.source.value === moduleName) {
      return true;
    }
  }

  return false;
}

export const serverOnlyModulesImportServerOnlyRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        'App-router server modules must import `"server-only"` so accidental client bundling fails at build time.',
    },
    schema: [optionSchema],
    messages: {
      missingServerOnlyImport:
        'Add `import "{{module}}";` — server modules under `app/` should fail fast if bundled for the client.',
    },
  },
  defaultOptions: [{ serverOnlyModule: DEFAULT_SERVER_ONLY_MODULE }],
  create(context, [options]) {
    const serverOnlyModule =
      options.serverOnlyModule ?? DEFAULT_SERVER_ONLY_MODULE;

    return {
      Program(node) {
        if (!isAppRouterFile(context.filename)) {
          return;
        }

        if (hasDirective(node, "use client")) {
          return;
        }

        if (hasServerOnlyImport(node, serverOnlyModule)) {
          return;
        }

        context.report({
          node,
          messageId: "missingServerOnlyImport",
          data: { module: serverOnlyModule },
        });
      },
    };
  },
});
