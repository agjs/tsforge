import type { TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  collectFastifyVariables,
  findNestedProperty,
  findRouteOptionsArg,
  getRouteMethodName,
} from "../utils/fastifyChain";

export const RULE_NAME = "require-response-schema";

type MessageIds = "missingResponseSchema";

export const requireResponseSchemaRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Fastify routes should declare schema.response for compiled fast-json-stringify serialization.",
    },
    schema: [],
    messages: {
      missingResponseSchema:
        "Route `.{{method}}(...)` should declare `schema.response` so Fastify can compile serializers at startup.",
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
          return;
        }

        const responseProp = findNestedProperty(options, "schema", "response");

        if (responseProp === null) {
          context.report({
            node,
            messageId: "missingResponseSchema",
            data: { method },
          });
        }
      },
    };
  },
});
