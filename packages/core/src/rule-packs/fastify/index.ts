import type { TSESLint } from "@typescript-eslint/utils";

import { errorHandlerMustSetStatusRule } from "./rules/error-handler-must-set-status";
import { preferReturnOverReplySendRule } from "./rules/prefer-return-over-reply-send";
import { requireFpForSharedPluginsRule } from "./rules/require-fp-for-shared-plugins";
import { requirePluginNameRule } from "./rules/require-plugin-name";
import { requireResponseSchemaRule } from "./rules/require-response-schema";
import { requireRouteSchemaRule } from "./rules/require-route-schema";
import { testInjectMustCloseAppRule } from "./rules/test-inject-must-close-app";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "error-handler-must-set-status": errorHandlerMustSetStatusRule,
  "prefer-return-over-reply-send": preferReturnOverReplySendRule,
  "require-fp-for-shared-plugins": requireFpForSharedPluginsRule,
  "require-fastify-plugin-name": requirePluginNameRule,
  "require-response-schema": requireResponseSchemaRule,
  "require-route-schema": requireRouteSchemaRule,
  "test-inject-must-close-app": testInjectMustCloseAppRule,
};

export const fastifyPack: IRulePack = {
  id: "fastify",
  description:
    "Fastify schema-first routing, plugin encapsulation, and test hygiene",
  rules,
  rulesConfig: {
    "error-handler-must-set-status": "error",
    "prefer-return-over-reply-send": "warn",
    "require-fp-for-shared-plugins": "error",
    "require-fastify-plugin-name": "error",
    "require-response-schema": "warn",
    "require-route-schema": "error",
    "test-inject-must-close-app": "error",
  },
};

export default fastifyPack;
