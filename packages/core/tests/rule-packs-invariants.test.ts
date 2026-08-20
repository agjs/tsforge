import { test, expect, describe } from "bun:test";
import { RULE_PACKS, buildPackEslintConfig } from "../src/rule-packs";
import { PACK_REGISTRY } from "../src/stack-detection";

// Latent silent-wrong-apply guards for the rules-driven gate. None of these
// catch a current bug — they pin invariants a future pack edit would otherwise
// break silently (a rule that registers but never runs; a detected pack that
// enforces nothing while appearing "applied").

describe("rule-pack invariants", () => {
  test("every built-in pack's rules and rulesConfig keys agree exactly", () => {
    // A rule in `rules` but not `rulesConfig` is registered yet never enabled
    // (a flat-config rule only runs with a severity) — it silently constrains
    // nothing. The reverse makes ESLint error at config build.
    for (const [id, pack] of Object.entries(RULE_PACKS)) {
      const ruleKeys = Object.keys(pack.rules).sort();
      const configKeys = Object.keys(pack.rulesConfig).sort();

      expect(
        configKeys,
        `pack "${id}": rulesConfig keys must match rules keys`
      ).toEqual(ruleKeys);
    }
  });

  test("every PACK_REGISTRY id contributes rules OR is an explicit guidance-only pack", () => {
    // A pack that stack-detection can select but that has no RULE_PACKS entry
    // contributes ZERO gate rules while still appearing "applied" (folded into
    // the stack name + prompt). Only these two are intentionally guidance-only
    // (their enforcement lives in the bundled strict config). A future typo'd or
    // forgotten pack id must trip THIS test, not silently enforce nothing.
    const GUIDANCE_ONLY = new Set(["generic-ts", "react"]);

    for (const id of Object.keys(PACK_REGISTRY)) {
      const contributesRules = Object.hasOwn(RULE_PACKS, id);

      expect(
        contributesRules || GUIDANCE_ONLY.has(id),
        `PACK_REGISTRY id "${id}" has no RULE_PACKS entry and is not a known guidance-only pack — it would be detected and shown as applied while enforcing nothing`
      ).toBe(true);
    }
  });

  test("overrides drop or replace a rule; a mistargeted override is a silent no-op", () => {
    const entry = Object.entries(RULE_PACKS).find(
      ([, pack]) => Object.keys(pack.rules).length > 0
    );

    expect(entry).toBeDefined();

    if (entry === undefined) {
      return;
    }

    const [packId, pack] = entry;
    const ruleName = Object.keys(pack.rules)[0];

    expect(ruleName).toBeDefined();

    if (ruleName === undefined) {
      return;
    }

    const key = `tsforge/${ruleName}`;
    const base = buildPackEslintConfig([packId]);

    expect(base.rules[key]).toBeDefined();

    // "off" removes the rule from the gate config entirely.
    const off = buildPackEslintConfig([packId], { [ruleName]: "off" });

    expect(off.rules[key]).toBeUndefined();

    // "warn"/"error" replaces the severity.
    const warned = buildPackEslintConfig([packId], { [ruleName]: "warn" });

    expect(warned.rules[key]).toBe("warn");

    // An override keyed to a rule NOT in the active pack set is silently
    // ignored (documents the footgun: strengthening a rule from an inactive
    // pack does nothing).
    const mistargeted = buildPackEslintConfig([packId], {
      "this-rule-is-in-no-active-pack": "error",
    });

    expect(mistargeted.rules).toEqual(base.rules);
  });
});
