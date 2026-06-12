import type { TSESLint } from "@typescript-eslint/utils";

import { staticTranslationKeyExistsRule } from "./rules/static-translation-key-exists";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "static-translation-key-exists": staticTranslationKeyExistsRule,
};

export const i18nKeysPack: IRulePack = {
  id: "i18n-keys",
  description: "Internationalization key management and translation patterns",
  rules,
  rulesConfig: {
    "static-translation-key-exists": "error",
  },
};

export default i18nKeysPack;
