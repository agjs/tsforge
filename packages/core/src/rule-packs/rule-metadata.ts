import type { IRuleCatalogEntry, RuleTier } from "./rule-catalog.types";

const DEFAULT_BY_TIER: Record<
  RuleTier,
  Omit<IRuleCatalogEntry, "tier"> & { tier: RuleTier }
> = {
  safety: { tier: "safety", falsePositiveRisk: "low" },
  framework: { tier: "framework", falsePositiveRisk: "low" },
  architecture: { tier: "architecture", falsePositiveRisk: "medium" },
  experimental: { tier: "experimental", falsePositiveRisk: "high" },
};

/** Explicit catalog entries; unlisted rules inherit tier from pack defaults. */
const RULE_ENTRIES: Readonly<Record<string, IRuleCatalogEntry>> = {
  "prefer-early-return": {
    tier: "architecture",
    tags: ["style"],
    falsePositiveRisk: "medium",
  },
  "component-folder-structure": { tier: "architecture", tags: ["react"] },
  "component-file-purity": { tier: "architecture", tags: ["react"] },
  "one-component-per-file": { tier: "architecture", tags: ["react"] },
  "no-state-in-component-body": { tier: "architecture", tags: ["react"] },
  "no-inline-jsx-functions": { tier: "architecture", tags: ["react"] },
  "no-anonymous-useEffect": {
    tier: "framework",
    tags: ["react"],
    falsePositiveRisk: "medium",
  },
  "no-derived-state-in-effect": {
    tier: "framework",
    tags: ["react"],
    falsePositiveRisk: "medium",
  },
  "no-html-img-element": { tier: "framework", tags: ["nextjs"] },
  "catch-must-handle": { tier: "safety", tags: ["security"] },
  "no-auth-token-in-storage": { tier: "safety", tags: ["security"] },
  "no-child-process-exec": { tier: "safety", tags: ["security"] },
  "no-dynamic-regexp": { tier: "safety", tags: ["security"] },
  "no-inner-html-assignment": { tier: "safety", tags: ["security"] },
  "no-spawn-with-shell": { tier: "safety", tags: ["security"] },
  "no-user-controlled-redirect": { tier: "safety", tags: ["security"] },
  "no-user-controlled-fetch-url": { tier: "safety", tags: ["security"] },
  "no-prototype-polluting-merge": { tier: "safety", tags: ["security"] },
  "webhook-must-verify-signature-before-parse": {
    tier: "safety",
    tags: ["security"],
  },
  "upload-must-set-limits": { tier: "safety", tags: ["security"] },
  "mutating-route-requires-authz": {
    tier: "experimental",
    tags: ["authorization"],
    falsePositiveRisk: "high",
  },
  "server-action-requires-authz": {
    tier: "experimental",
    tags: ["authorization", "nextjs"],
    falsePositiveRisk: "high",
  },
  "server-action-requires-authz-and-validation": {
    tier: "experimental",
    tags: ["authorization", "nextjs", "validation"],
    falsePositiveRisk: "high",
  },
  "jwt-must-verify-not-decode": { tier: "safety", tags: ["security", "jwt"] },
  "auth-cookie-must-set-samesite": {
    tier: "safety",
    tags: ["security", "cookies"],
  },
  "auth-cookie-must-set-maxage-or-expires": {
    tier: "safety",
    tags: ["security", "cookies"],
    falsePositiveRisk: "medium",
  },
  "update-delete-must-have-where": {
    tier: "safety",
    tags: ["drizzle", "database"],
  },
  "update-delete-account-scoped-must-filter-scope": {
    tier: "safety",
    tags: ["drizzle", "database", "multi-tenant"],
  },
  "caught-error-log-requires-cause": { tier: "framework", tags: ["logging"] },
  "logger-not-console": {
    tier: "architecture",
    tags: ["logging"],
    falsePositiveRisk: "medium",
  },
  "server-only-modules-import-server-only": {
    tier: "framework",
    tags: ["nextjs"],
  },
  "no-secret-props-to-client": { tier: "safety", tags: ["nextjs", "security"] },
  "mutation-should-revalidate-cache": {
    tier: "framework",
    tags: ["nextjs"],
    falsePositiveRisk: "medium",
  },
  "no-conditional-expect": { tier: "framework", tags: ["testing"] },
  "fake-timers-must-be-restored": { tier: "framework", tags: ["testing"] },
  "no-real-network-in-unit-tests": {
    tier: "framework",
    tags: ["testing"],
    falsePositiveRisk: "medium",
  },
  "id-param-requires-object-authz": {
    tier: "experimental",
    tags: ["authorization"],
    falsePositiveRisk: "high",
  },
  "fetch-must-check-ok": { tier: "safety", tags: ["async", "http"] },
  "json-parse-must-validate": { tier: "safety", tags: ["validation"] },
  "no-unsafe-boundary-cast": { tier: "safety", tags: ["validation"] },
  "exported-functions-require-return-type": {
    tier: "framework",
    falsePositiveRisk: "medium",
  },
  "prefer-named-three-imports": {
    tier: "framework",
    tags: ["three"],
    falsePositiveRisk: "medium",
  },
  "no-disabled-frustum-culling": {
    tier: "framework",
    tags: ["three"],
    falsePositiveRisk: "medium",
  },
  "no-unbounded-device-pixel-ratio": {
    tier: "framework",
    tags: ["three"],
    falsePositiveRisk: "medium",
  },
  "no-phaser-import-in-pure-layers": {
    tier: "safety",
    tags: ["phaser"],
  },
  "no-ignore-destroy": { tier: "safety", tags: ["phaser"] },
  "no-unmanaged-global-listeners": { tier: "safety", tags: ["phaser"] },
  "no-raw-scene-key-literal": {
    tier: "architecture",
    tags: ["phaser"],
  },
  "no-raw-texture-key-literal": {
    tier: "architecture",
    tags: ["phaser"],
    falsePositiveRisk: "medium",
  },
};

const PACK_DEFAULT_TIER: Readonly<Record<string, RuleTier>> = {
  security: "safety",
  "runtime-boundaries": "safety",
  authorization: "experimental",
  "typescript-core": "safety",
  "react-component-architecture": "framework",
  nextjs: "framework",
  fastify: "framework",
  elysia: "framework",
  drizzle: "framework",
  bullmq: "framework",
  three: "framework",
  phaser: "framework",
  "comment-hygiene": "architecture",
  "code-flow": "framework",
};

export function getRuleCatalogEntry(
  ruleId: string,
  packId?: string
): IRuleCatalogEntry {
  const explicit = RULE_ENTRIES[ruleId];

  if (explicit !== undefined) {
    return explicit;
  }

  const packTier = packId !== undefined ? PACK_DEFAULT_TIER[packId] : undefined;
  const tier = packTier ?? "framework";

  return DEFAULT_BY_TIER[tier];
}

export function listRulesByTier(
  rules: readonly { packId: string; ruleId: string }[]
): Map<RuleTier, { packId: string; ruleId: string }[]> {
  const byTier = new Map<RuleTier, { packId: string; ruleId: string }[]>();

  for (const entry of rules) {
    const meta = getRuleCatalogEntry(entry.ruleId, entry.packId);
    const list = byTier.get(meta.tier) ?? [];

    list.push(entry);
    byTier.set(meta.tier, list);
  }

  return byTier;
}
