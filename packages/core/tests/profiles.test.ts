import { describe, test, expect } from "bun:test";
import { RULE_PACKS, buildPackEslintConfig } from "../src/rule-packs";
import { resolveActivePacks } from "../src/config/tsforge-config";
import {
  resolveProfileRuleOverrides,
  PROFILE_DEFINITIONS,
  PROFILE_IDS,
  STRUCTURE_RULES,
  isProfileId,
  type IProfileDefinition,
  type ProfileId,
} from "../src/config/profiles";
import { profileFlagError } from "../src/cli/args";

// Strict-by-default: the layout-AGNOSTIC best practices (no-inline-jsx-functions,
// forwardref-display-name) must NOT be disabled in the default profiles — only the
// STRUCTURE rules (tsforge's specific file/folder layout) are off by default so tsforge
// stays adoptable on an existing repo.
test("default profiles keep quality rules ON and only disable STRUCTURE rules", () => {
  for (const profile of ["recommended", "strict", "security"] as const) {
    const overrides = resolveProfileRuleOverrides(profile);

    // Quality best-practices are NOT forced off (they run at their pack default).
    expect(overrides["no-inline-jsx-functions"]).toBeUndefined();
    expect(overrides["forwardref-display-name"]).toBeUndefined();

    // Every STRUCTURE rule (the tsforge-specific layout) IS off by default.
    for (const rule of STRUCTURE_RULES) {
      expect(overrides[rule]).toBe("off");
    }
  }
});

// The opinionated profile (greenfield / opt-in) turns the STRUCTURE rules back ON.
test("opinionated profile enables the STRUCTURE rules", () => {
  const overrides = resolveProfileRuleOverrides("opinionated");

  expect(overrides["component-folder-structure"]).toBe("error");
  expect(overrides["no-state-in-component-body"]).toBe("error");
  expect(overrides["index-must-reexport-default"]).toBe("error");
  // The strictest profile must never LOWER a quality rule below the default — these are
  // "error", never "warn" (a past leftover) or "off".
  expect(overrides["no-inline-jsx-functions"]).toBe("error");
  expect(overrides["forwardref-display-name"]).toBe("error");
});

/**
 * A profile must never set a rule below the severity its own pack ships it at.
 * Any exception must be declared in INTENTIONAL_RELAXATIONS with a reason, so a
 * weaker gate cannot be introduced silently. Keep that list as close to empty as
 * the product allows.
 */

const RANK: Readonly<Record<string, number>> = { off: 0, warn: 1, error: 2 };

/**
 * Every relaxation we accept, `profile:rule` -> why. Adding an entry is a
 * deliberate act; that is the point.
 */
/**
 * The rule names below are written out rather than imported from
 * STRUCTURE_RULES ON PURPOSE, and must stay that way.
 *
 * STRUCTURE_RULES drives `structureOffOverrides`, i.e. the very relaxations this
 * list authorises. Deriving the allowlist from it would mean adding a rule there
 * turns it off in five profiles AND writes its own permission slip, and both
 * tests below would still pass. Duplicating the names forces a second, deliberate
 * edit here before a new rule may be switched off.
 */
const OPT_IN_STRUCTURE_RULES = [
  "component-folder-structure",
  "index-must-reexport-default",
  "no-state-in-component-body",
  "max-hooks-per-file",
] as const;

const NON_OPINIONATED_PROFILES = ["recommended", "strict", "security"] as const;

const INTENTIONAL_RELAXATIONS: Readonly<Record<string, string>> = {
  // These impose tsforge's specific file/folder layout, so they stay off unless a
  // project opts into `opinionated` — otherwise tsforge could not be adopted on an
  // existing repo with its own valid structure.
  ...Object.fromEntries(
    NON_OPINIONATED_PROFILES.flatMap((profile) =>
      OPT_IN_STRUCTURE_RULES.map((rule) => [
        `${profile}:${rule}`,
        "opt-in structure rule, off outside the opinionated profile",
      ])
    )
  ),
};

interface IPackDefault {
  severity: string;
  packId: string;
}

/** Bare rule name -> the severity its own pack ships it at. */
function packDefaults(): Map<string, IPackDefault> {
  const out = new Map<string, IPackDefault>();

  for (const [packId, pack] of Object.entries(RULE_PACKS)) {
    for (const [rule, severity] of Object.entries(pack.rulesConfig)) {
      // Keep the STRICTEST default when two packs ship the same rule name.
      // Last-write-wins would let a weaker later pack hide the fact that an
      // override lowers the rule below an earlier pack's default.
      const prior = out.get(rule);

      if (prior === undefined || rank(severity) > rank(prior.severity)) {
        out.set(rule, { severity, packId });
      }
    }
  }

  return out;
}

interface ILowering {
  key: string;
  detail: string;
}

function rank(severity: string): number {
  return RANK[severity] ?? 0;
}

/** Every profile override that is strictly weaker than its pack default. */
function lowerings(definitions: readonly IProfileDefinition[]): ILowering[] {
  const defaults = packDefaults();
  const found: ILowering[] = [];

  for (const definition of definitions) {
    const overrides = definition.ruleOverrides ?? {};

    for (const [rule, override] of Object.entries(overrides)) {
      const base = defaults.get(rule);

      if (base === undefined) {
        continue;
      }

      if (rank(override) < rank(base.severity)) {
        found.push({
          key: `${definition.id}:${rule}`,
          detail: `${definition.id} lowers ${rule} from ${base.severity} (pack ${base.packId}) to ${override}`,
        });
      }
    }
  }

  return found;
}

const ALL_PROFILES = Object.values(PROFILE_DEFINITIONS);

describe("no profile silently weakens its pack's rules", () => {
  test("every relaxation is declared intentional", () => {
    const undeclared = lowerings(ALL_PROFILES)
      .filter((l) => !Object.hasOwn(INTENTIONAL_RELAXATIONS, l.key))
      .map((l) => l.detail);

    expect(undeclared).toEqual([]);
  });

  test("the opinionated profile — the strictest — lowers nothing at all", () => {
    // It exists to turn the architecture rules ON. Anything it sets below its
    // pack default is a bug by construction, allowlist or not.
    expect(
      lowerings([PROFILE_DEFINITIONS.opinionated]).map((l) => l.detail)
    ).toEqual([]);
  });

  test("opinionated re-enables every structure rule at error", () => {
    const overrides = PROFILE_DEFINITIONS.opinionated.ruleOverrides ?? {};

    for (const rule of STRUCTURE_RULES) {
      expect(overrides[rule]).toBe("error");
    }
  });

  test("every allowlist entry carries a real reason", () => {
    // Object.hasOwn alone would accept `"frontend:some-rule": ""`, letting a
    // downgrade be waved through with no justification.
    for (const [key, reason] of Object.entries(INTENTIONAL_RELAXATIONS)) {
      expect({ key, reason: reason.trim().length >= 20 }).toEqual({
        key,
        reason: true,
      });
    }
  });

  test("the allowlist's structure-rule list matches production", () => {
    // The duplication above is deliberate, but it must not silently fall behind:
    // a rule added to STRUCTURE_RULES has to be considered here explicitly.
    expect([...OPT_IN_STRUCTURE_RULES].sort()).toEqual(
      [...STRUCTURE_RULES].sort()
    );
  });

  test("the allowlist has no stale entries", () => {
    // A relaxation that has since been fixed must not keep its permission slip.
    const active = new Set(lowerings(ALL_PROFILES).map((l) => l.key));

    for (const key of Object.keys(INTENTIONAL_RELAXATIONS)) {
      expect({ key, stillRelaxed: active.has(key) }).toEqual({
        key,
        stillRelaxed: true,
      });
    }
  });
});

// F21: `frontend` was removed because its only distinguishing content was a
// relaxation — it downgraded two React rules that `recommended` leaves at error, so
// the profile you would pick FOR a React app was the weaker one. Without a
// regression here, deleting it from the type is undone by anyone re-adding it, and
// the audit decision lives only in a commit message.
describe("the profile set is the authoritative list", () => {
  // Every remaining profile must EARN its place — differ from `recommended` by more
  // than nothing. `frontend` (F21) and `backend` (F24) were both removed for failing
  // that: one relaxed two React rules, the other differed only by omitting an
  // override that matched its rule's pack default.
  test("is exactly the four intended ids", () => {
    expect([...PROFILE_IDS].sort()).toEqual([
      "opinionated",
      "recommended",
      "security",
      "strict",
    ]);
  });

  test("rejects the removed profile ids", () => {
    for (const removed of ["frontend", "backend"]) {
      expect({ removed, valid: isProfileId(removed) }).toEqual({
        removed,
        valid: false,
      });
      expect(PROFILE_IDS).not.toContain(removed);
    }
  });

  // The valid-id list used to be hand-maintained in three places, which is exactly
  // what goes stale when a profile is added or removed. These assert the strings are
  // DERIVED, so a hardcoded copy fails rather than quietly lying to the user.
  // THE STANDARD, as an assertion rather than a comment. Both removed profiles died
  // because nothing enforced this: `backend` resolved to identical behaviour to
  // `recommended` and survived for months, and prose saying "a profile must differ"
  // would not have caught the next one either.
  //
  // Everything here goes through the PRODUCTION resolvers, not the declarations.
  // `resolveActivePacks` is what actually decides the pack set — it filters against
  // PACK_REGISTRY — so a profile declaring `extraPacks: ["not-a-real-pack"]` would
  // look different while resolving identically. Comparing what a profile DECLARES is
  // the same declaration-vs-effect confusion that let `backend` survive: its only
  // textual difference was omitting an override matching its rule's pack default.
  //
  // Meta-rule elevations are deliberately NOT part of the snapshot: the meta-rule
  // layer exposes no default-severity table to resolve against, so "elevate to error"
  // cannot be distinguished from a no-op elevation of a rule already at error. A
  // profile whose ONLY difference is a meta-rule elevation therefore fails this test
  // until that table exists — a false positive, which is the safe direction.
  test("every profile behaves differently from recommended", () => {
    const allPacks = Object.keys(RULE_PACKS);
    const effective = (id: ProfileId): string =>
      JSON.stringify({
        // The resolved pack set, filtered exactly as production filters it.
        packs: [...resolveActivePacks([], { profile: id })].sort(),
        // Rule severities over every pack, so an override's effect is visible even
        // when the profile enables no packs of its own.
        rules: buildPackEslintConfig(allPacks, resolveProfileRuleOverrides(id))
          .rules,
      });

    const baseline = effective("recommended");

    for (const id of PROFILE_IDS) {
      if (id === "recommended" || !isProfileId(id)) {
        continue;
      }

      expect({ id, sameAsRecommended: effective(id) === baseline }).toEqual({
        id,
        sameAsRecommended: false,
      });
    }
  });

  test("the unknown-profile error lists the ids from the same source", () => {
    const message = profileFlagError("frontend", true) ?? "";

    expect(message).toContain('unknown --profile "frontend"');

    // Compare the LISTED ids exactly. "Contains every current id" passes a stale
    // hardcoded list that still advertises `frontend` as valid, because `frontend`
    // is also in the message as the REJECTED value — the same hole as the config
    // warning, which is why both compare the list rather than scanning it.
    const listed = /valid: (.+)$/u.exec(message)?.[1];

    expect(listed).toBe(PROFILE_IDS.join(", "));
  });
});
