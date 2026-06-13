import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

/** Narrow `unknown` to a record without a type assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const REMOTE_DEP_PATTERN =
  /^(?:git\+|git:|http:|https:\/\/(?!registry\.npmjs\.org))/iu;

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }

  return out;
}

export const noGitOrTarballDependenciesRule: IMetaRule = {
  id: "no-git-or-tarball-dependencies",
  category: "supply-chain",
  description:
    "Warn on git+, git:, or http(s) tarball dependency URLs in package.json.",
  severity: "warn",
  run({ packageJson }) {
    const violations: IMetaRuleViolation[] = [];

    if (packageJson === null) {
      return violations;
    }

    for (const section of DEP_SECTIONS) {
      const entries = toStringRecord(packageJson[section]);

      if (entries === undefined) {
        continue;
      }

      for (const [name, spec] of Object.entries(entries)) {
        if (!REMOTE_DEP_PATTERN.test(spec)) {
          continue;
        }

        violations.push({
          file: "package.json",
          ruleId: "no-git-or-tarball-dependencies",
          severity: "warn",
          message: `${section}.${name} uses remote URL "${spec}" — prefer registry versions for reproducible installs and supply-chain auditing.`,
        });
      }
    }

    return violations;
  },
};
