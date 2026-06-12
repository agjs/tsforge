import type { TSESLint } from "@typescript-eslint/utils";

import { noHistoricalCommentsRule } from "./rules/no-historical-comments";
import { noNarrationCommentsRule } from "./rules/no-narration-comments";
import { noPrReferenceCommentsRule } from "./rules/no-pr-reference-comments";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "no-historical-comments": noHistoricalCommentsRule,
  "no-narration-comments": noNarrationCommentsRule,
  "no-pr-reference-comments": noPrReferenceCommentsRule,
};

export const commentHygienePack: IRulePack = {
  id: "comment-hygiene",
  description: "Meaningful comments and documentation standards",
  rules,
  rulesConfig: {
    "no-historical-comments": "error",
    "no-narration-comments": "error",
    "no-pr-reference-comments": "error",
  },
};

export default commentHygienePack;
