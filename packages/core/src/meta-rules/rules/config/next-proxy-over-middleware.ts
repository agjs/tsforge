import { parsePackageJsonObject } from "../../parsers/package-json-parser";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

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

function fileExists(
  readFile: (relPath: string) => string | null,
  paths: readonly string[]
): boolean {
  return paths.some((path) => readFile(path) !== null);
}

export const nextProxyOverMiddlewareRule: IMetaRule = {
  id: "next-proxy-over-middleware",
  category: "config",
  description:
    "When using Next.js 16+, prefer proxy.ts over legacy middleware.ts for early request interception.",
  severity: "warn",
  appliesTo: ["nextjs"],
  run({ packageJson, readFile }) {
    const violations: IMetaRuleViolation[] = [];

    if (!hasNextDependency(packageJson)) {
      return violations;
    }

    const middlewarePaths = ["middleware.ts", "src/middleware.ts"] as const;
    const proxyPaths = ["proxy.ts", "src/proxy.ts"] as const;

    const hasMiddleware = fileExists(readFile, middlewarePaths);
    const hasProxy = fileExists(readFile, proxyPaths);

    if (hasMiddleware && !hasProxy) {
      violations.push({
        file: "middleware.ts",
        ruleId: "next-proxy-over-middleware",
        severity: "warn",
        message:
          "middleware.ts is legacy — migrate early request interception to proxy.ts (Next.js 16 Node.js-native routing boundary).",
      });
    }

    return violations;
  },
};
