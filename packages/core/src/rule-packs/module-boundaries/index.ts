import type { TSESLint } from "@typescript-eslint/utils";

import { noImportBuildOutputRule } from "./rules/no-import-build-output";
import { noImportTestFromSourceRule } from "./rules/no-import-test-from-source";
import { noReactInServicesRule } from "./rules/no-react-in-services";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "no-import-build-output": noImportBuildOutputRule,
  "no-import-test-from-source": noImportTestFromSourceRule,
  "no-react-in-services": noReactInServicesRule,
};

export const moduleBoundariesPack: IRulePack = {
  id: "module-boundaries",
  description:
    "Module boundary hygiene: keep the test/production and source/build-output boundaries clean so the dependency graph stays sound.",
  rules,
  rulesConfig: {
    "no-import-build-output": "error",
    "no-import-test-from-source": "error",
    "no-react-in-services": "error",
  },
};

export default moduleBoundariesPack;
