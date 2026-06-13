import { parsePackageJsonObject } from "../../parsers/package-json-parser";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

const NEXT_CONFIG_PATHS = [
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
] as const;

const WILDCARD_HOSTNAME_PATTERN =
  /hostname\s*:\s*['"`]\*\*['"`]|hostname\s*:\s*['"`][^'"`]*\*[^'"`]*['"`]/;

function hasNextDependency(
  packageJson: Record<string, unknown> | null
): boolean {
  if (packageJson === null) {
    return false;
  }

  const parsed = parsePackageJsonObject(packageJson);

  if (parsed === null) {
    return false;
  }

  const merged: Record<string, string> = {
    ...(parsed.dependencies ?? {}),
    ...(parsed.devDependencies ?? {}),
  };

  return merged.next !== undefined;
}

function configContainsWildcardRemotePattern(content: string): boolean {
  if (!content.includes("remotePatterns")) {
    return false;
  }

  return WILDCARD_HOSTNAME_PATTERN.test(content);
}

export const nextImageRemotePatternsNoWildcardsRule: IMetaRule = {
  id: "next-image-remote-patterns-no-wildcards",
  category: "config",
  description:
    "Disallow wildcard hostnames in `images.remotePatterns` — overly broad patterns enable SSRF via next/image.",
  severity: "error",
  appliesTo: ["nextjs"],
  run({ packageJson, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    if (!hasNextDependency(packageJson)) {
      return violations;
    }

    for (const path of NEXT_CONFIG_PATHS) {
      const content = readFile(path);

      if (content === null) {
        continue;
      }

      if (configContainsWildcardRemotePattern(content)) {
        violations.push({
          file: path,
          ruleId: "next-image-remote-patterns-no-wildcards",
          severity: "error",
          message:
            "`images.remotePatterns` contains a wildcard hostname — list explicit hostnames instead of `**` or `*`-patterns to reduce SSRF risk.",
        });
      }
    }

    return violations;
  },
};
