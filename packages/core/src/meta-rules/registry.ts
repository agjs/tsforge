import type { IMetaRule } from "./meta-rules.types";
import { packageExactDepsRule } from "./rules/supply-chain/package-exact-deps";
import { noOverlappingLibsRule } from "./rules/supply-chain/no-overlapping-libs";
import { noEslintDisableCommentsRule } from "./rules/source-text/no-eslint-disable-comments";
import { noTsSuppressionRule } from "./rules/source-text/no-ts-suppressions";
import { tsconfigPathsExistRule } from "./rules/config/tsconfig-paths-exist";
import { tsconfigStrictRule } from "./rules/config/tsconfig-strict";
import { testSiblingRequiredRule } from "./rules/testing/test-sibling-required";
import { workflowActionsPinnedRule } from "./rules/ci/workflow-actions-pinned";
import { workflowRunnerPinnedRule } from "./rules/ci/workflow-runner-pinned";
import { workflowTimeoutRequiredRule } from "./rules/ci/workflow-timeout-required";

/**
 * All available meta-rules, ordered by category for readability.
 * Apply-filtering (appliesTo) happens in the runner per context.
 */
export const META_RULES: readonly IMetaRule[] = [
  // Supply chain
  packageExactDepsRule,
  noOverlappingLibsRule,

  // Source text
  noEslintDisableCommentsRule,
  noTsSuppressionRule,

  // Config
  tsconfigPathsExistRule,
  tsconfigStrictRule,

  // Testing
  testSiblingRequiredRule,

  // CI
  workflowActionsPinnedRule,
  workflowRunnerPinnedRule,
  workflowTimeoutRequiredRule,
];
