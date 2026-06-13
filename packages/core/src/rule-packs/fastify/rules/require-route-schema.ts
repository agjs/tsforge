import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  MUTATING_METHODS,
  collectFastifyVariables,
  findNestedProperty,
  findRouteOptionsArg,
  getRouteMethodName,
} from "../utils/fastifyChain";

export const RULE_NAME = "require-route-schema";

type MessageIds = "missingSchema" | "missingBodySchema";

export const requireRouteSchemaRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Fastify POST/PUT/PATCH routes must declare schema.body; GET/DELETE routes must declare schema.querystring or schema.params.",
    },
    schema: [],
    messages: {
      missingSchema:
        "Route `.{{method}}(...)` must declare a `schema` object with validation for inputs.",
      missingBodySchema:
        "Mutating route `.{{method}}(...)` must declare `schema.body` for request validation.",
    },
  },
  defaultOptions: [],
  create(context) {
    let fastifyVars = new Set<string>();

    return {
      Program(program: TSESTree.Program) {
        fastifyVars = collectFastifyVariables(program);
      },
      CallExpression(node: TSESTree.CallExpression) {
        const method = getRouteMethodName(node, fastifyVars);

        if (method === null) {
          return;
        }

        const options = findRouteOptionsArg(node);

        if (options === null) {
          context.report({
            node,
            messageId: "missingSchema",
            data: { method },
          });

          return;
        }

        const schemaProp = findNestedProperty(options, "schema");
        const schemaObject =
          schemaProp?.value.type === AST_NODE_TYPES.ObjectExpression
            ? schemaProp.value
            : null;

        if (schemaObject === null) {
          context.report({
            node,
            messageId: "missingSchema",
            data: { method },
          });

          return;
        }

        if (MUTATING_METHODS.has(method)) {
          const bodyProp = findNestedProperty(options, "schema", "body");

          if (bodyProp === null) {
            context.report({
              node,
              messageId: "missingBodySchema",
              data: { method },
            });
          }
        } else {
          const queryProp = findNestedProperty(
            options,
            "schema",
            "querystring"
          );
          const paramsProp = findNestedProperty(options, "schema", "params");

          if (queryProp === null && paramsProp === null) {
            context.report({
              node,
              messageId: "missingSchema",
              data: { method },
            });
          }
        }
      },
    };
  },
});
