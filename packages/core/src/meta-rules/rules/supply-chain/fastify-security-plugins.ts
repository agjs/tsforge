import { parsePackageJsonObject } from "../../parsers/package-json-parser";
import type { IMetaRule, IMetaRuleViolation } from "../../meta-rules.types";

const SECURITY_PLUGINS = [
  "@fastify/helmet",
  "@fastify/cors",
  "@fastify/rate-limit",
] as const;

export const fastifySecurityPluginsRule: IMetaRule = {
  id: "fastify-security-plugins",
  category: "supply-chain",
  description:
    "When fastify is a dependency, recommend official security plugins (@fastify/helmet, @fastify/cors, @fastify/rate-limit).",
  severity: "warn",
  appliesTo: ["fastify"],
  run({ packageJson }) {
    const violations: IMetaRuleViolation[] = [];

    if (packageJson === null) {
      return violations;
    }

    const parsed = parsePackageJsonObject(packageJson);

    if (parsed === null) {
      return violations;
    }

    const merged: Record<string, string> = {
      ...(parsed.dependencies ?? {}),
      ...(parsed.devDependencies ?? {}),
    };

    if (merged.fastify === undefined) {
      return violations;
    }

    const missing = SECURITY_PLUGINS.filter((pkg) => merged[pkg] === undefined);

    if (missing.length === 0) {
      return violations;
    }

    violations.push({
      file: "package.json",
      ruleId: "fastify-security-plugins",
      severity: "warn",
      message: `fastify is listed but security plugins are missing: ${missing.join(", ")}. Register @fastify/helmet, @fastify/cors, and @fastify/rate-limit at the production boundary.`,
    });

    return violations;
  },
};
