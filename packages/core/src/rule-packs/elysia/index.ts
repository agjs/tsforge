import type { TSESLint } from "@typescript-eslint/utils";

import { consistentStatusViaSetRule } from "./rules/consistent-status-via-set";
import { noDecorateStateCollisionRule } from "./rules/no-decorate-state-collision";
import { noSeparateModelInterfacesRule } from "./rules/no-separate-model-interfaces";
import { preferDestructuredContextRule } from "./rules/prefer-destructured-context";
import { preferDirectReturnRule } from "./rules/prefer-direct-return";
import { preferStaticServicesRule } from "./rules/prefer-static-services";
import { preferThrowStatusRule } from "./rules/prefer-throw-status";
import { requireHooksBeforeRoutesRule } from "./rules/require-hooks-before-routes";
import { requirePluginNameRule } from "./rules/require-plugin-name";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "consistent-status-via-set": consistentStatusViaSetRule,
  "no-decorate-state-collision": noDecorateStateCollisionRule,
  "no-separate-model-interfaces": noSeparateModelInterfacesRule,
  "prefer-destructured-context": preferDestructuredContextRule,
  "prefer-direct-return": preferDirectReturnRule,
  "prefer-static-services": preferStaticServicesRule,
  "prefer-throw-status": preferThrowStatusRule,
  "require-hooks-before-routes": requireHooksBeforeRoutesRule,
  "require-elysia-plugin-name": requirePluginNameRule,
};

export const elysiaPack: IRulePack = {
  id: "elysia",
  description: "Elysia framework best practices and type-safety patterns",
  rules,
  rulesConfig: {
    "consistent-status-via-set": "error",
    "no-decorate-state-collision": "error",
    "no-separate-model-interfaces": "warn",
    "prefer-destructured-context": "warn",
    "prefer-direct-return": "warn",
    "prefer-static-services": "warn",
    "prefer-throw-status": "warn",
    "require-hooks-before-routes": "error",
    "require-elysia-plugin-name": "error",
  },
};

export default elysiaPack;
