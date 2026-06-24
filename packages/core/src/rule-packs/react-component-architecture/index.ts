import type { TSESLint } from "@typescript-eslint/utils";

import { dangerousHtmlRequiresSanitizeRule } from "./rules/dangerous-html-requires-sanitize";
import { componentFilePurityRule } from "./rules/component-file-purity";
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
import { noLoadingTextUseSkeletonRule } from "./rules/no-loading-text-use-skeleton";
import { noNestedComponentRule } from "./rules/no-nested-component";
import { noReactFcRule } from "./rules/no-react-fc";
import { noStateInComponentBodyRule } from "./rules/no-state-in-component-body";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "component-file-purity": componentFilePurityRule,
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
  "no-loading-text-use-skeleton": noLoadingTextUseSkeletonRule,
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
    "component-file-purity": "error",
    "component-folder-structure": "error",
    "dangerous-html-requires-sanitize": "error",
    "forwardref-display-name": "error",
    "index-must-reexport-default": "error",
    "max-hooks-per-file": "error",
    "no-anonymous-useEffect": "error",
    "no-component-invocation": "error",
    "no-cross-feature-imports": "error",
    "no-derived-state-in-effect": "error",
    // Stays WARN: inline event handlers (`onClick={() => setOpen(true)}`,
    // `onChange={(e) => setX(e.target.value)}`) are idiomatic React; hard-blocking
    // them forces awkward extraction and avalanched a form-heavy build (32 at one
    // gate). Advisory only — the other promoted rules flag genuine smells, this
    // one flags a standard pattern.
    "no-inline-jsx-functions": "warn",
    "no-jsx-computation": "error",
    "no-loading-text-use-skeleton": "error",
    "no-nested-component": "error",
    "no-react-fc": "error",
    "no-state-in-component-body": "error",
  },
};

export default reactComponentArchitecturePack;
