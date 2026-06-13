import type { TSESLint } from "@typescript-eslint/utils";

import { dangerousHtmlRequiresSanitizeRule } from "./rules/dangerous-html-requires-sanitize";
import { componentFolderStructureRule } from "./rules/component-folder-structure";
import { forwardrefDisplayNameRule } from "./rules/forwardref-display-name";
import { indexMustReexportDefaultRule } from "./rules/index-must-reexport-default";
import { maxHooksPerFileRule } from "./rules/max-hooks-per-file";
import { noAnonymousUseEffectRule } from "./rules/no-anonymous-useEffect";
import { noComponentInvocationRule } from "./rules/no-component-invocation";
import { noCrossFeatureImportsRule } from "./rules/no-cross-feature-imports";
import { noDerivedStateInEffectRule } from "./rules/no-derived-state-in-effect";
import { noInlineJsxFunctionsRule } from "./rules/no-inline-jsx-functions";
import { noJsxComputationRule } from "./rules/no-jsx-computation";
import { noNestedComponentRule } from "./rules/no-nested-component";
import { noReactFcRule } from "./rules/no-react-fc";
import { noStateInComponentBodyRule } from "./rules/no-state-in-component-body";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "component-folder-structure": componentFolderStructureRule,
  "dangerous-html-requires-sanitize": dangerousHtmlRequiresSanitizeRule,
  "forwardref-display-name": forwardrefDisplayNameRule,
  "index-must-reexport-default": indexMustReexportDefaultRule,
  "max-hooks-per-file": maxHooksPerFileRule,
  "no-anonymous-useEffect": noAnonymousUseEffectRule,
  "no-component-invocation": noComponentInvocationRule,
  "no-cross-feature-imports": noCrossFeatureImportsRule,
  "no-derived-state-in-effect": noDerivedStateInEffectRule,
  "no-inline-jsx-functions": noInlineJsxFunctionsRule,
  "no-jsx-computation": noJsxComputationRule,
  "no-nested-component": noNestedComponentRule,
  "no-react-fc": noReactFcRule,
  "no-state-in-component-body": noStateInComponentBodyRule,
};

export const reactComponentArchitecturePack: IRulePack = {
  id: "react-component-architecture",
  description:
    "Component structure, composition, and file organization for React",
  rules,
  rulesConfig: {
    "component-folder-structure": "error",
    "dangerous-html-requires-sanitize": "error",
    "forwardref-display-name": "error",
    "index-must-reexport-default": "error",
    "max-hooks-per-file": "warn",
    "no-anonymous-useEffect": "warn",
    "no-component-invocation": "error",
    "no-cross-feature-imports": "error",
    "no-derived-state-in-effect": "warn",
    "no-inline-jsx-functions": "warn",
    "no-jsx-computation": "error",
    "no-nested-component": "error",
    "no-react-fc": "error",
    "no-state-in-component-body": "error",
  },
};

export default reactComponentArchitecturePack;
