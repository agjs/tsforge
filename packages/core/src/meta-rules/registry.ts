import type { IMetaRule } from "./meta-rules.types";
import { packageExactDepsRule } from "./rules/supply-chain/package-exact-deps";
import { fastifySecurityPluginsRule } from "./rules/supply-chain/fastify-security-plugins";
import { noOverlappingLibsRule } from "./rules/supply-chain/no-overlapping-libs";
import { lockfileRequiredRule } from "./rules/supply-chain/lockfile-required";
import { singlePackageManagerRule } from "./rules/supply-chain/single-package-manager";
import { packageManagerFieldRequiredRule } from "./rules/supply-chain/package-manager-field-required";
import { noGitOrTarballDependenciesRule } from "./rules/supply-chain/no-git-or-tarball-dependencies";
import { dependencyOverridesRequireCommentRule } from "./rules/supply-chain/dependency-overrides-require-comment";
import { productionMustNotUseDrizzlePushRule } from "./rules/supply-chain/production-must-not-use-drizzle-push";
import { migrationsMustBeCheckedInRule } from "./rules/supply-chain/migrations-must-be-checked-in";
import { noEslintDisableCommentsRule } from "./rules/source-text/no-eslint-disable-comments";
import { noTsSuppressionRule } from "./rules/source-text/no-ts-suppressions";
import { nextImageRemotePatternsNoWildcardsRule } from "./rules/config/next-image-remote-patterns-no-wildcards";
import { nextInstrumentationPresentRule } from "./rules/config/next-instrumentation-present";
import { nextProxyOverMiddlewareRule } from "./rules/config/next-proxy-over-middleware";
import { tsconfigPathsExistRule } from "./rules/config/tsconfig-paths-exist";
import { tsconfigRecommendedFlagsRule } from "./rules/config/tsconfig-recommended-flags";
import { tsconfigStrictRule } from "./rules/config/tsconfig-strict";
import { testSiblingRequiredRule } from "./rules/testing/test-sibling-required";
import { workflowActionsPinnedRule } from "./rules/ci/workflow-actions-pinned";
import { workflowRunnerPinnedRule } from "./rules/ci/workflow-runner-pinned";
import { workflowTimeoutRequiredRule } from "./rules/ci/workflow-timeout-required";
import { workflowPermissionsExplicitRule } from "./rules/ci/workflow-permissions-explicit";
import { workflowPermissionsLeastPrivilegeRule } from "./rules/ci/workflow-permissions-least-privilege";
import { noPullRequestTargetUntrustedCheckoutRule } from "./rules/ci/no-pull-request-target-untrusted-checkout";
import { noGithubContextInShellRule } from "./rules/ci/no-github-context-in-shell";
import { dockerfileBaseImagePinnedRule } from "./rules/docker/dockerfile-base-image-pinned";
import { dockerfileNonRootUserRule } from "./rules/docker/dockerfile-non-root-user";
import { dockerfileNoSecretsInEnvArgRule } from "./rules/docker/dockerfile-no-secrets-in-env-arg";

/**
 * All available meta-rules, ordered by category for readability.
 * Apply-filtering (appliesTo) happens in the runner per context.
 */
export const META_RULES: readonly IMetaRule[] = [
  // Supply chain
  packageExactDepsRule,
  fastifySecurityPluginsRule,
  noOverlappingLibsRule,
  lockfileRequiredRule,
  singlePackageManagerRule,
  packageManagerFieldRequiredRule,
  noGitOrTarballDependenciesRule,
  dependencyOverridesRequireCommentRule,
  productionMustNotUseDrizzlePushRule,
  migrationsMustBeCheckedInRule,

  // Source text
  noEslintDisableCommentsRule,
  noTsSuppressionRule,

  // Config
  tsconfigPathsExistRule,
  tsconfigRecommendedFlagsRule,
  tsconfigStrictRule,
  nextProxyOverMiddlewareRule,
  nextInstrumentationPresentRule,
  nextImageRemotePatternsNoWildcardsRule,

  // Testing
  testSiblingRequiredRule,

  // CI
  workflowActionsPinnedRule,
  workflowRunnerPinnedRule,
  workflowTimeoutRequiredRule,
  workflowPermissionsExplicitRule,
  workflowPermissionsLeastPrivilegeRule,
  noPullRequestTargetUntrustedCheckoutRule,
  noGithubContextInShellRule,

  // Container
  dockerfileBaseImagePinnedRule,
  dockerfileNonRootUserRule,
  dockerfileNoSecretsInEnvArgRule,
];
