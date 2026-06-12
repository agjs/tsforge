// Generate RULES.md: a catalog of all rule packs and meta-rules.
// This produces a deterministic, human-readable reference of what gets enforced.
//   bun run packages/core/scripts/build-rules-md.ts
import { join } from "node:path";
import { RULE_PACKS } from "../src/rule-packs";
import { META_RULES } from "../src/meta-rules";

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

const out: string[] = [
  "# Rules and Meta-Rules Catalog",
  "",
  "This document lists all rules enforced by tsforge across rule packs and meta-rules.",
  "",
];

// Section: Rule Packs
out.push("## Rule Packs");
out.push("");

type PackId = keyof typeof RULE_PACKS;

function isPackId(id: string): id is PackId {
  return id in RULE_PACKS;
}

const packIds = Object.keys(RULE_PACKS).sort();

for (const packId of packIds) {
  if (!isPackId(packId)) {
    continue;
  }

  const pack = RULE_PACKS[packId];

  out.push(`### ${packId}`);
  out.push("");
  out.push(pack.description);
  out.push("");

  const ruleNames = Object.keys(pack.rules).sort();

  for (const ruleName of ruleNames) {
    const rule = pack.rules[ruleName];
    const severity = pack.rulesConfig[ruleName] ?? "warn";
    const description = getRuleDescription(rule) ?? ruleName;
    const severityUpper = severity.toUpperCase();
    const line = `- **${ruleName}** [${severityUpper}]: ${description}`;

    out.push(line);
  }

  out.push("");
}

// Section: Meta-Rules
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

// Render meta-rules by category.
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

const path = join(import.meta.dir, "..", "RULES.md");

await Bun.write(path, out.join("\n"));
process.stdout.write(`\nwrote rules catalog → ${path}\n`);
