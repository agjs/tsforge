import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "json-parse-must-validate";

type MessageIds = "bareJsonParse";

const VALIDATOR_IMPORTS = new Set([
  "zod",
  "valibot",
  "@effect/schema",
  "effect/Schema",
  "arktype",
]);

function fileHasValidatorImport(program: TSESTree.Program): boolean {
  for (const stmt of program.body) {
    if (stmt.type !== AST_NODE_TYPES.ImportDeclaration) {
      continue;
    }

    const source = stmt.source.value;

    if (typeof source !== "string") {
      continue;
    }

    const base = source.split("/")[0];

    if (base !== undefined && VALIDATOR_IMPORTS.has(base)) {
      return true;
    }

    if (VALIDATOR_IMPORTS.has(source)) {
      return true;
    }
  }

  return false;
}

function isTestFile(filename: string): boolean {
  return (
    filename.includes(".test.") ||
    filename.includes(".spec.") ||
    filename.includes("/__tests__/")
  );
}

export const jsonParseMustValidateRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow bare JSON.parse on untrusted input — validate through a schema library.",
    },
    schema: [],
    messages: {
      bareJsonParse:
        "Do not use bare `JSON.parse` on external input — parse through Zod, Valibot, or Effect Schema.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (isTestFile(context.filename)) {
      return {};
    }

    let hasValidator = false;

    return {
      Program(node: TSESTree.Program) {
        hasValidator = fileHasValidatorImport(node);
      },
      CallExpression(node: TSESTree.CallExpression) {
        if (hasValidator) {
          return;
        }

        const callee = node.callee;

        if (
          callee.type === AST_NODE_TYPES.MemberExpression &&
          !callee.computed &&
          callee.object.type === AST_NODE_TYPES.Identifier &&
          callee.object.name === "JSON" &&
          callee.property.type === AST_NODE_TYPES.Identifier &&
          callee.property.name === "parse"
        ) {
          context.report({ node, messageId: "bareJsonParse" });
        }
      },
    };
  },
});
