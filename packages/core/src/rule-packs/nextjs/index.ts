import type { TSESLint } from "@typescript-eslint/utils";

import { awaitDynamicRequestApisRule } from "./rules/await-dynamic-request-apis";
import { clientHooksRequireUseClientRule } from "./rules/client-hooks-require-use-client";
import { errorBoundaryRequireUseClientRule } from "./rules/error-boundary-require-use-client";
import { mutationShouldRevalidateCacheRule } from "./rules/mutation-should-revalidate-cache";
import { noHtmlImgElementRule } from "./rules/no-html-img-element";
import { noInternalApiFetchRule } from "./rules/no-internal-api-fetch";
import { noNextHeadInAppRule } from "./rules/no-next-head-in-app";
import { noPagesRouterDataFetchingInAppRule } from "./rules/no-pages-router-data-fetching-in-app";
import { noSecretPropsToClientRule } from "./rules/no-secret-props-to-client";
import { noSensitiveNextPublicEnvRule } from "./rules/no-sensitive-next-public-env";
import { preferLazyUseStateInitRule } from "./rules/prefer-lazy-use-state-init";
import { serverActionRequiresAuthzAndValidationRule } from "./rules/server-action-requires-authz-and-validation";
import { serverOnlyModulesImportServerOnlyRule } from "./rules/server-only-modules-import-server-only";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "await-dynamic-request-apis": awaitDynamicRequestApisRule,
  "client-hooks-require-use-client": clientHooksRequireUseClientRule,
  "error-boundary-require-use-client": errorBoundaryRequireUseClientRule,
  "mutation-should-revalidate-cache": mutationShouldRevalidateCacheRule,
  "no-html-img-element": noHtmlImgElementRule,
  "no-internal-api-fetch": noInternalApiFetchRule,
  "no-next-head-in-app": noNextHeadInAppRule,
  "no-pages-router-data-fetching-in-app": noPagesRouterDataFetchingInAppRule,
  "no-secret-props-to-client": noSecretPropsToClientRule,
  "no-sensitive-next-public-env": noSensitiveNextPublicEnvRule,
  "prefer-lazy-use-state-init": preferLazyUseStateInitRule,
  "server-action-requires-authz-and-validation":
    serverActionRequiresAuthzAndValidationRule,
  "server-only-modules-import-server-only":
    serverOnlyModulesImportServerOnlyRule,
};

export const nextjsPack: IRulePack = {
  id: "nextjs",
  description:
    "Next.js app-router correctness: server/client component boundaries and dead pages-router APIs.",
  rules,
  rulesConfig: {
    "await-dynamic-request-apis": "error",
    "client-hooks-require-use-client": "error",
    "error-boundary-require-use-client": "error",
    "mutation-should-revalidate-cache": "warn",
    "no-html-img-element": "warn",
    "no-internal-api-fetch": "error",
    "no-next-head-in-app": "error",
    "no-pages-router-data-fetching-in-app": "error",
    "no-secret-props-to-client": "warn",
    "no-sensitive-next-public-env": "error",
    "prefer-lazy-use-state-init": "warn",
    "server-action-requires-authz-and-validation": "error",
    "server-only-modules-import-server-only": "error",
  },
};

export default nextjsPack;
