import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";

export const RULE_NAME = "max-hooks-per-file";

export interface MaxHooksPerFileOptions {
  readonly threshold?: number;
  readonly filePattern?: string;
}

type RuleOptions = [MaxHooksPerFileOptions];
type MessageIds = "tooManyHooks";

const DEFAULT_THRESHOLD = 4;
const DEFAULT_FILE_PATTERN = "\\.(queries|hooks|mutations)\\.tsx?$";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    threshold: { type: "integer", minimum: 1 },
    filePattern: { type: "string", minLength: 1 },
  },
};

function isHookName(name: string): boolean {
  if (name.length < 4 || !name.startsWith("use")) {
    return false;
  }

  const fourth = name[3];

  return fourth !== undefined && /^[A-Z]/.test(fourth);
}

function collectExportedHookName(
  statement: TSESTree.ProgramStatement
): string | null {
  if (statement.type !== AST_NODE_TYPES.ExportNamedDeclaration) {
    return null;
  }

  const decl = statement.declaration;

  if (decl === null || decl === undefined) {
    return null;
  }

  if (decl.type === AST_NODE_TYPES.FunctionDeclaration) {
    if (decl.id !== null && isHookName(decl.id.name)) {
      return decl.id.name;
    }

    return null;
  }

  if (decl.type === AST_NODE_TYPES.VariableDeclaration) {
    for (const declarator of decl.declarations) {
      if (
        declarator.id.type === AST_NODE_TYPES.Identifier &&
        isHookName(declarator.id.name)
      ) {
        return declarator.id.name;
      }
    }
  }

  return null;
}

export const maxHooksPerFileRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag query/hook modules that export more than N hooks. Same-kind modules pass the single-semantic-module rule but still grow into god files; this rule sets a hard ceiling so the split conversation happens early.",
    },
    schema: [optionSchema],
    messages: {
      tooManyHooks:
        "This file exports {{count}} hooks ({{names}}), exceeding the threshold of {{threshold}}. Split into focused modules (e.g. *.list.queries.ts + *.mutations.ts).",
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    const pattern = new RegExp(options.filePattern ?? DEFAULT_FILE_PATTERN);

    if (!pattern.test(context.filename)) {
      return {};
    }

    return {
      Program(program) {
        const hookNames: string[] = [];

        for (const statement of program.body) {
          const name = collectExportedHookName(statement);

          if (name !== null) {
            hookNames.push(name);
          }
        }

        if (hookNames.length > threshold) {
          context.report({
            node: program,
            messageId: "tooManyHooks",
            data: {
              count: String(hookNames.length),
              threshold: String(threshold),
              names: hookNames.join(", "),
            },
          });
        }
      },
    };
  },
});
