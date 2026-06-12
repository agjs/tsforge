import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-error-stringify";

export interface NoErrorStringifyOptions {
  readonly errorIdentifierNames?: readonly string[];
  readonly extractorName?: string;
}

type RuleOptions = [NoErrorStringifyOptions];
type MessageIds = "noErrorStringify";

const DEFAULT_ERROR_NAMES: readonly string[] = ["error", "err", "e", "cause"];
const DEFAULT_EXTRACTOR = "getErrorMessage";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    errorIdentifierNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    extractorName: { type: "string", minLength: 1 },
  },
};

function isErrorIdentifier(
  node: TSESTree.Node,
  names: ReadonlySet<string>
): node is TSESTree.Identifier {
  return node.type === AST_NODE_TYPES.Identifier && names.has(node.name);
}

function isExtractorImported(
  program: TSESTree.Program,
  extractor: string
): boolean {
  for (const statement of program.body) {
    if (statement.type !== AST_NODE_TYPES.ImportDeclaration) {
      continue;
    }

    for (const spec of statement.specifiers) {
      if (
        spec.type === AST_NODE_TYPES.ImportSpecifier &&
        spec.local.name === extractor
      ) {
        return true;
      }
    }
  }

  return false;
}

export const noErrorStringifyRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow stringifying errors with `String(error)` / `${error}` / `error.toString()` — strips the cause chain. Use a configured extractor instead.",
    },
    fixable: "code",
    schema: [optionSchema],
    messages: {
      noErrorStringify:
        "Stringifying an error drops its cause chain — call `{{extractor}}(error)` instead.",
    },
  },
  defaultOptions: [
    {
      errorIdentifierNames: [...DEFAULT_ERROR_NAMES],
      extractorName: DEFAULT_EXTRACTOR,
    },
  ],
  create(context, [options]) {
    const errorNames = new Set(
      options.errorIdentifierNames ?? DEFAULT_ERROR_NAMES
    );
    const extractor = options.extractorName ?? DEFAULT_EXTRACTOR;

    let extractorImported = false;

    return {
      Program(program) {
        extractorImported = isExtractorImported(program, extractor);
      },
      // `String(error)` / `String(err)` ...
      CallExpression(node) {
        const firstArg = node.arguments[0];

        if (
          node.callee.type === AST_NODE_TYPES.Identifier &&
          node.callee.name === "String" &&
          node.arguments.length === 1 &&
          firstArg !== undefined &&
          isErrorIdentifier(firstArg, errorNames)
        ) {
          const errIdent = firstArg;

          context.report({
            node,
            messageId: "noErrorStringify",
            data: { extractor },
            ...(extractorImported
              ? {
                  fix(fixer) {
                    return fixer.replaceText(
                      node,
                      `${extractor}(${errIdent.name})`
                    );
                  },
                }
              : {}),
          });
        }
      },
      // `error.toString()`
      "CallExpression[callee.type='MemberExpression']"(
        node: TSESTree.CallExpression
      ) {
        const { callee } = node;

        if (callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        if (
          !callee.computed &&
          callee.property.type === AST_NODE_TYPES.Identifier &&
          callee.property.name === "toString" &&
          isErrorIdentifier(callee.object, errorNames) &&
          node.arguments.length === 0
        ) {
          const errIdent = callee.object;

          context.report({
            node,
            messageId: "noErrorStringify",
            data: { extractor },
            ...(extractorImported
              ? {
                  fix(fixer) {
                    return fixer.replaceText(
                      node,
                      `${extractor}(${errIdent.name})`
                    );
                  },
                }
              : {}),
          });
        }
      },
      // `${error}` inside a TemplateLiteral
      TemplateLiteral(node) {
        for (const expr of node.expressions) {
          if (isErrorIdentifier(expr, errorNames)) {
            const errIdent = expr;

            context.report({
              node: expr,
              messageId: "noErrorStringify",
              data: { extractor },
              ...(extractorImported
                ? {
                    fix(fixer) {
                      return fixer.replaceText(
                        errIdent,
                        `${extractor}(${errIdent.name})`
                      );
                    },
                  }
                : {}),
            });
          }
        }
      },
      // `error + ""` or `"" + error`
      BinaryExpression(node) {
        if (node.operator !== "+") {
          return;
        }

        const sides: TSESTree.Node[] = [node.left, node.right];
        const hasEmptyString = sides.some(
          (n) =>
            n.type === AST_NODE_TYPES.Literal &&
            typeof n.value === "string" &&
            n.value === ""
        );

        if (!hasEmptyString) {
          return;
        }

        for (const side of sides) {
          if (isErrorIdentifier(side, errorNames)) {
            context.report({
              node,
              messageId: "noErrorStringify",
              data: { extractor },
            });

            return;
          }
        }
      },
    };
  },
});
