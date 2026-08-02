import { describe, test, expect } from "bun:test";
import { RULE_PACKS } from "../src/rule-packs";
import {
  PROFILE_DEFINITIONS,
  STRUCTURE_RULES,
  type IProfileDefinition,
} from "../src/config/profiles";

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
const INTENTIONAL_RELAXATIONS: Readonly<Record<string, string>> = {
  // The STRUCTURE_RULES impose tsforge's specific file/folder layout. They are
  // opt-in so tsforge stays adoptable on an existing repo with its own valid
  // structure, and turn on with the `opinionated` profile. Documented at the
  // STRUCTURE_RULES declaration in src/config/profiles.ts.
  ...Object.fromEntries(
    ["recommended", "strict", "security", "frontend", "backend"].flatMap(
      (profile) =>
        STRUCTURE_RULES.map((rule) => [
          `${profile}:${rule}`,
          "opt-in structure rule, off outside the opinionated profile",
        ])
    )
  ),
  // Nothing else. The `frontend` profile used to downgrade
  // no-anonymous-useEffect and no-derived-state-in-effect from error to warn;
  // those overrides were removed rather than allowlisted (F20), so the only
  // accepted relaxations are the documented opt-in structure rules above.
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
      out.set(rule, { severity, packId });
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
