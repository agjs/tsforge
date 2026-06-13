import type { TSESLint } from "@typescript-eslint/utils";

import { componentFolderStructureRule } from "./rules/component-folder-structure";
import { forwardrefDisplayNameRule } from "./rules/forwardref-display-name";
import { indexMustReexportDefaultRule } from "./rules/index-must-reexport-default";
import { maxHooksPerFileRule } from "./rules/max-hooks-per-file";
import { noCrossFeatureImportsRule } from "./rules/no-cross-feature-imports";
import { noInlineJsxFunctionsRule } from "./rules/no-inline-jsx-functions";
import { noJsxComputationRule } from "./rules/no-jsx-computation";
import { noStateInComponentBodyRule } from "./rules/no-state-in-component-body";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "component-folder-structure": componentFolderStructureRule,
  "forwardref-display-name": forwardrefDisplayNameRule,
  "index-must-reexport-default": indexMustReexportDefaultRule,
  "max-hooks-per-file": maxHooksPerFileRule,
  "no-cross-feature-imports": noCrossFeatureImportsRule,
  "no-inline-jsx-functions": noInlineJsxFunctionsRule,
  "no-jsx-computation": noJsxComputationRule,
  "no-state-in-component-body": noStateInComponentBodyRule,
};

export const reactComponentArchitecturePack: IRulePack = {
  id: "react-component-architecture",
  description:
    "Component structure, composition, and file organization for React",
  rules,
  rulesConfig: {
    "component-folder-structure": "error",
    "forwardref-display-name": "error",
    "index-must-reexport-default": "error",
    "max-hooks-per-file": "warn",
    "no-cross-feature-imports": "error",
    "no-inline-jsx-functions": "warn",
    "no-jsx-computation": "error",
    "no-state-in-component-body": "error",
  },
};

export default reactComponentArchitecturePack;
