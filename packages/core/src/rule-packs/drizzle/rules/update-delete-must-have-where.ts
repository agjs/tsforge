import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { matchesAnyGlobPattern, ruleRelativePath } from "../../utils";
import { chainContainsWhere, identifyUpdateDeleteQuery } from "../utils";

export const RULE_NAME = "update-delete-must-have-where";

export interface IUpdateDeleteMustHaveWhereOptions {
  readonly allowFiles?: readonly string[];
}

type RuleOptions = [IUpdateDeleteMustHaveWhereOptions];
type MessageIds = "missingWhere";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allowFiles: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true,
    },
  },
};

export const updateDeleteMustHaveWhereRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every Drizzle `.update()` and `.delete()` call to include a `.where()` clause — unscoped writes affect every row.",
    },
    schema: [optionSchema],
    messages: {
      missingWhere:
        "Drizzle `.{{kind}}()` on `{{table}}` is missing `.where()` — unscoped writes can mutate every row in the table.",
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const allowFiles = options.allowFiles ?? [];

    if (
      matchesAnyGlobPattern(
        ruleRelativePath(context.filename, context.cwd),
        allowFiles
      )
    ) {
      return {};
    }

    return {
      CallExpression(node) {
        const query = identifyUpdateDeleteQuery(node);

        if (query === null) {
          return;
        }

        if (chainContainsWhere(node)) {
          return;
        }

        context.report({
          node,
          messageId: "missingWhere",
          data: { kind: query.kind, table: query.table },
        });
      },
    };
  },
});
