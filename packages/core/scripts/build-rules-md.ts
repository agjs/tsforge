// Generate RULES.md grouped by adoption tier, then pack.
import { join } from "node:path";
import { RULE_PACKS } from "../src/rule-packs";
import { META_RULES } from "../src/meta-rules";
import { getRuleCatalogEntry } from "../src/rule-packs/rule-metadata";
import type { RuleTier } from "../src/rule-packs/rule-catalog.types";
import { PROFILE_DEFINITIONS } from "../src/config/profiles";

function getRuleDescription(obj: unknown): string | undefined {
  const isObject = (val: unknown): val is Record<string, unknown> =>
    val !== null && typeof val === "object";

  if (!isObject(obj)) {
    return undefined;
  }

  const meta = obj.meta;

  if (!isObject(meta)) {
    return undefined;
  }

  const docs = meta.docs;

  if (!isObject(docs)) {
    return undefined;
  }

  const description = docs.description;

  return typeof description === "string" ? description : undefined;
}

const TIER_ORDER: readonly RuleTier[] = [
  "safety",
  "framework",
  "architecture",
  "experimental",
];

const out: string[] = [
  "# Rules and Meta-Rules Catalog",
  "",
  "Rules are grouped by **adoption tier**. Use `profile` in `tsforge.config.json` to control which tiers are active by default.",
  "",
  "## Profiles",
  "",
];

for (const profile of Object.values(PROFILE_DEFINITIONS)) {
  out.push(`- **${profile.id}**: ${profile.description}`);
}

out.push("");
out.push("## Rule Packs by Tier");
out.push("");

type PackId = keyof typeof RULE_PACKS;

function isPackId(id: string): id is PackId {
  return id in RULE_PACKS;
}

const entriesByTier = new Map<
  RuleTier,
  { packId: string; ruleName: string; severity: string; description: string }[]
>();

for (const packId of Object.keys(RULE_PACKS).sort()) {
  if (!isPackId(packId)) {
    continue;
  }

  const pack = RULE_PACKS[packId];

  for (const ruleName of Object.keys(pack.rules).sort()) {
    const rule = pack.rules[ruleName];
    const severity = pack.rulesConfig[ruleName] ?? "warn";
    const description = getRuleDescription(rule) ?? ruleName;
    const tier = getRuleCatalogEntry(ruleName, packId).tier;
    const list = entriesByTier.get(tier) ?? [];

    list.push({
      packId,
      ruleName,
      severity: severity.toUpperCase(),
      description,
    });
    entriesByTier.set(tier, list);
  }
}

for (const tier of TIER_ORDER) {
  const entries = entriesByTier.get(tier) ?? [];

  if (entries.length === 0) {
    continue;
  }

  out.push(`### Tier: ${tier}`);
  out.push("");

  for (const entry of entries.sort((a, b) => {
    const byPack = a.packId.localeCompare(b.packId);

    if (byPack !== 0) {
      return byPack;
    }

    return a.ruleName.localeCompare(b.ruleName);
  })) {
    out.push(
      `- **${entry.packId}/${entry.ruleName}** [${entry.severity}]: ${entry.description}`
    );
  }

  out.push("");
}

out.push("## Meta-Rules");
out.push("");
out.push(
  "Meta-rules enforce project structure and configuration invariants that ESLint cannot express."
);
out.push("");

const categoryOrder = [
  "supply-chain",
  "config",
  "source-text",
  "testing",
  "stack-layout",
  "ci",
] as const;

const rulesByCategory = new Map<string, (typeof META_RULES)[number][]>();

for (const rule of META_RULES) {
  const cat = rule.category;
  const rules = rulesByCategory.get(cat) ?? [];

  rules.push(rule);
  rulesByCategory.set(cat, rules);
}

for (const category of categoryOrder) {
  const rules = rulesByCategory.get(category) ?? [];

  if (rules.length === 0) {
    continue;
  }

  out.push(`### ${category}`);
  out.push("");

  for (const rule of rules.sort((a, b) => a.id.localeCompare(b.id))) {
    out.push(
      `- **${rule.id}** [${rule.severity.toUpperCase()}]: ${rule.description}`
    );
  }

  out.push("");
}

out.push("## Out of scope");
out.push("");
out.push(
  "The following are intentionally deferred — wrong tool for the syntactic ESLint gate, or require cross-file analysis:"
);
out.push("");
out.push(
  "- GraphQL/WebSocket/OpenAPI contract rules (until OpenAPI dep + parser)"
);
out.push(
  "- Container/Kubernetes YAML hardening (future meta-rules when Dockerfile/k8s detected)"
);
out.push("- LLM/MCP security packs (opt-in when AI SDK deps detected)");
out.push("- FSD layer DAG / full authorization taint tracking");
out.push("- Lighthouse / bundle-analyzer CI gates");
out.push("- Violation ratcheting / baseline snapshots (Phase 5)");
out.push("");

const path = join(import.meta.dir, "..", "RULES.md");

await Bun.write(path, out.join("\n"));
process.stdout.write(`\nwrote rules catalog → ${path}\n`);
