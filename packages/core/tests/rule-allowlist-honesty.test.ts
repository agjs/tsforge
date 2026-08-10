import { test, expect, describe } from "bun:test";
import { RULE_PACKS } from "../src/rule-packs";
import {
  matchesAnyGlobPattern,
  matchesGlobPattern,
} from "../src/rule-packs/utils";
import { PACK_RULE_DOCS } from "../src/loop/feedback/pack-rule-docs";
import { isRecord } from "../src/lib/guards";

/**
 * Allowlist / message honesty — same family as rule-docs-examples and profiles.
 *
 * Dogfood burned turns when a rule *message* promised `src/cli.ts` / `env.ts` but
 * the default allowlist only had the folder glob. This suite fails CI when path
 * claims in messages or pack docs are not covered by default allowlist patterns.
 */

/** Backtick segments that look like repo paths (not prose / imports alone). */
const PATHISH =
  /(?:^|\/)(?:src|scripts|bin|tests|drizzle|apps|packages)(?:\/|$)|(?:\.|\/)(?:ts|tsx|js|mjs|cjs|jsx)$|\/\*\*|^\*\*\//;

/** Known file-vs-folder twins: `foo/**` alone misses `foo.ts`. */
const SINGLETON_STEMS = [
  "src/config/env",
  "src/config/error-handlers",
  "src/cli",
] as const;

/** Synthetic paths that structural defaults should still match. */
const STRUCTURAL_INVENTORY = [
  "drizzle/migrations/001_init.ts",
  "src/db/raw/query.ts",
  "src/health/check.ts",
  "src/foo.check.ts",
  "src/oauth/state.ts",
  "src/config/env.ts",
  "src/cli.ts",
  "next.config.ts",
] as const;

function extractPathClaims(text: string): string[] {
  const claims: string[] = [];
  const re = /`([^`]+)`/g;
  let match = re.exec(text);

  while (match !== null) {
    const raw = match[1]?.trim() ?? "";

    if (raw.length > 0 && PATHISH.test(raw)) {
      claims.push(raw.replace(/\/$/u, ""));
    }

    match = re.exec(text);
  }

  return claims;
}

function allowlistFromOptions(options: unknown): readonly string[] | null {
  if (!isRecord(options)) {
    return null;
  }

  for (const key of ["allowedFiles", "allowFiles", "stateFiles"] as const) {
    const value = options[key];

    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      return value;
    }
  }

  return null;
}

/**
 * RuleCreator still installs defaults on the rule object; the typed
 * `defaultOptions` accessor is deprecated in favor of meta.defaultOptions, which
 * our packs do not populate. Reflect avoids the deprecated typed member.
 */
function firstDefaultOption(rule: object): unknown {
  const options = Reflect.get(rule, "defaultOptions");

  if (!Array.isArray(options) || options.length === 0) {
    return undefined;
  }

  return options[0];
}

/** True when a prose path claim is covered by at least one allowlist pattern. */
function claimCoveredBy(claim: string, patterns: readonly string[]): boolean {
  const normalized = claim.replace(/\/$/u, "");
  const probes = [
    normalized,
    `${normalized}/x.ts`,
    normalized.endsWith(".ts") ? normalized : `${normalized}.ts`,
  ];

  if (patterns.some((p) => p === normalized || p === `${normalized}/**`)) {
    return true;
  }

  return probes.some((probe) => matchesAnyGlobPattern(probe, patterns));
}

function messageTexts(rule: {
  readonly meta: { readonly messages?: Readonly<Record<string, string>> };
}): string[] {
  const messages = rule.meta.messages;

  if (messages === undefined) {
    return [];
  }

  return Object.values(messages);
}

describe("rule-allowlist-honesty", () => {
  test("path claims in allowlist-rule messages are covered by default patterns", () => {
    const gaps: string[] = [];

    for (const [packId, pack] of Object.entries(RULE_PACKS)) {
      for (const [ruleName, rule] of Object.entries(pack.rules)) {
        const patterns = allowlistFromOptions(firstDefaultOption(rule));

        if (patterns === null || patterns.length === 0) {
          continue;
        }

        for (const text of messageTexts(rule)) {
          for (const claim of extractPathClaims(text)) {
            if (!claimCoveredBy(claim, patterns)) {
              gaps.push(
                `${packId}/${ruleName}: message claims \`${claim}\` but defaults do not cover it`
              );
            }
          }
        }
      }
    }

    expect(gaps).toEqual([]);
  });

  test("path claims in PACK_RULE_DOCS.what are covered when the rule has an allowlist", () => {
    const gaps: string[] = [];

    for (const [packId, pack] of Object.entries(RULE_PACKS)) {
      for (const [ruleName, rule] of Object.entries(pack.rules)) {
        const patterns = allowlistFromOptions(firstDefaultOption(rule));

        if (patterns === null || patterns.length === 0) {
          continue;
        }

        const doc = PACK_RULE_DOCS[`tsforge/${ruleName}`];

        if (doc === undefined) {
          continue;
        }

        for (const claim of extractPathClaims(doc.what)) {
          if (!claimCoveredBy(claim, patterns)) {
            gaps.push(
              `${packId}/${ruleName} (${packId}): pack doc claims \`${claim}\` but defaults do not cover it`
            );
          }
        }
      }
    }

    expect(gaps).toEqual([]);
  });

  test("folder globs for known singletons also list the sibling .ts file", () => {
    const gaps: string[] = [];

    for (const [packId, pack] of Object.entries(RULE_PACKS)) {
      for (const [ruleName, rule] of Object.entries(pack.rules)) {
        const patterns = allowlistFromOptions(firstDefaultOption(rule));

        if (patterns === null) {
          continue;
        }

        for (const stem of SINGLETON_STEMS) {
          const folder = `${stem}/**`;

          if (!patterns.includes(folder)) {
            continue;
          }

          const file = `${stem}.ts`;

          if (!patterns.includes(file)) {
            gaps.push(
              `${packId}/${ruleName}: has ${folder} but missing sibling ${file}`
            );
          }
        }
      }
    }

    expect(gaps).toEqual([]);
  });

  test("structural defaults still match a synthetic inventory", () => {
    const misses: string[] = [];
    const required: readonly { pattern: string; example: string }[] = [
      {
        pattern: "**/migrations/**",
        example: "drizzle/migrations/001_init.ts",
      },
      { pattern: "**/oauth/state.ts", example: "src/oauth/state.ts" },
      { pattern: "src/config/env.ts", example: "src/config/env.ts" },
      { pattern: "**/*.config.{ts,js,mjs}", example: "next.config.ts" },
    ];

    for (const [packId, pack] of Object.entries(RULE_PACKS)) {
      for (const [ruleName, rule] of Object.entries(pack.rules)) {
        const patterns = allowlistFromOptions(firstDefaultOption(rule));

        if (patterns === null) {
          continue;
        }

        for (const { pattern, example } of required) {
          if (!patterns.includes(pattern)) {
            continue;
          }

          if (!matchesGlobPattern(example, pattern)) {
            misses.push(
              `${packId}/${ruleName}: pattern ${pattern} does not match ${example}`
            );
          }
        }
      }
    }

    // Inventory itself must be recognized by the matcher helpers (sanity).
    expect(
      STRUCTURAL_INVENTORY.some((p) =>
        matchesGlobPattern(p, "**/migrations/**")
      )
    ).toBe(true);

    expect(misses).toEqual([]);
  });
});
