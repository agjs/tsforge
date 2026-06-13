import type { TSESLint } from "@typescript-eslint/utils";

import { clientHooksRequireUseClientRule } from "./rules/client-hooks-require-use-client";
import { noNextHeadInAppRule } from "./rules/no-next-head-in-app";
import { noPagesRouterDataFetchingInAppRule } from "./rules/no-pages-router-data-fetching-in-app";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "client-hooks-require-use-client": clientHooksRequireUseClientRule,
  "no-next-head-in-app": noNextHeadInAppRule,
  "no-pages-router-data-fetching-in-app": noPagesRouterDataFetchingInAppRule,
};

export const nextjsPack: IRulePack = {
  id: "nextjs",
  description:
    "Next.js app-router correctness: server/client component boundaries and dead pages-router APIs.",
  rules,
  rulesConfig: {
    "client-hooks-require-use-client": "error",
    "no-next-head-in-app": "error",
    "no-pages-router-data-fetching-in-app": "error",
  },
};

export default nextjsPack;
