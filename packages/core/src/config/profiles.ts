import type { ProfileId } from "../rule-packs/rule-catalog.types";

export type { ProfileId };

export interface IProfileDefinition {
  readonly id: ProfileId;
  readonly label: string;
  readonly description: string;
  /** Extra packs to include beyond stack detection (deduped at resolve time). */
  readonly extraPacks?: readonly string[];
  /** Rule severity overrides keyed by bare rule name. */
  readonly ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>;
  /** Meta-rule ids to elevate to error in this profile. */
  readonly metaRulesAtError?: readonly string[];
}

/** Rules that impose tsforge's SPECIFIC file/folder organization — WHERE code must
 *  live (a `src/views/<Feature>/` tree, hooks in a colocated `.hooks.ts`, an `index`
 *  re-export). These are off by default so tsforge stays adoptable on an EXISTING repo
 *  that has its own valid structure; they turn on when the project opts into the
 *  `opinionated` profile (tsforge.config.json or `--profile opinionated`) — e.g. a
 *  greenfield app where tsforge owns the tree. The strictness moat — the
 *  layout-AGNOSTIC best practices (no `as`, no `any`, no JSX computation, component-file
 *  purity, named JSX handlers, forwardRef display names, …) — is ON in every profile. */
export const STRUCTURE_RULES = [
  "component-folder-structure",
  "index-must-reexport-default",
  "no-state-in-component-body",
  "max-hooks-per-file",
] as const;

const structureOffOverrides = Object.fromEntries(
  STRUCTURE_RULES.map((rule) => [rule, "off" as const])
);

export const PROFILE_DEFINITIONS: Readonly<
  Record<ProfileId, IProfileDefinition>
> = {
  recommended: {
    id: "recommended",
    label: "Recommended",
    description:
      "Safety + framework packs from stack detection; architecture opinions off by default.",
    ruleOverrides: {
      ...structureOffOverrides,
      "prefer-early-return": "warn",
    },
  },
  strict: {
    id: "strict",
    label: "Strict",
    description:
      "Recommended plus CI/supply-chain meta-rules at error and type-aware async rules.",
    extraPacks: ["typescript-core"],
    ruleOverrides: {
      ...structureOffOverrides,
      "prefer-early-return": "warn",
    },
    metaRulesAtError: [
      "workflow-permissions-explicit",
      "lockfile-required",
      "single-package-manager",
    ],
  },
  security: {
    id: "security",
    label: "Security",
    description:
      "Recommended plus runtime-boundaries and experimental authorization heuristics.",
    extraPacks: ["runtime-boundaries", "authorization"],
    ruleOverrides: structureOffOverrides,
  },
  frontend: {
    id: "frontend",
    label: "Frontend",
    description:
      "Recommended, scoped to frontend work; React/Next rules keep their pack severities.",
    // This block used to read `no-html-img-element`/`no-anonymous-useEffect`/
    // `no-derived-state-in-effect` at "warn". That was one no-op and two real
    // downgrades: the nextjs pack already ships no-html-img-element at warn,
    // while react-component-architecture ships the other two at ERROR — which
    // `recommended` leaves alone. So `--profile frontend`, the profile you would
    // pick FOR a React app, was weaker on two React correctness rules than the
    // default. Removed, so the pack severities stand.
    ruleOverrides: structureOffOverrides,
  },
  backend: {
    id: "backend",
    label: "Backend",
    description:
      "Recommended; stack detection adds Fastify/Elysia/Drizzle/BullMQ packs.",
    ruleOverrides: structureOffOverrides,
  },
  opinionated: {
    id: "opinionated",
    label: "Opinionated",
    description:
      "Full house-style architecture rules including component folder structure.",
    ruleOverrides: {
      "component-folder-structure": "error",
      "no-state-in-component-body": "error",
      // `error`, NOT `warn` — the strictest profile must never lower a quality rule below
      // the default (where no-inline-jsx-functions is already on). warn here was a leftover
      // from when this rule was off by default.
      "no-inline-jsx-functions": "error",
      "index-must-reexport-default": "error",
      "forwardref-display-name": "error",
      // Same reason, same leftover: the pack ships this at `error`, and this
      // profile exists to turn the structure rules ON, so `warn` made the
      // strictest profile weaker than the pack it sits on.
      // tests/profile-severity.test.ts now enforces this for every profile.
      "max-hooks-per-file": "error",
      "prefer-early-return": "error",
    },
  },
};

export const DEFAULT_PROFILE: ProfileId = "recommended";

/** The valid profile ids, for `--profile` validation + error messages. */
export const PROFILE_IDS: readonly string[] = Object.keys(PROFILE_DEFINITIONS);

export function isProfileId(value: string): value is ProfileId {
  // `Object.hasOwn`, NOT the `in` operator — `in` walks the prototype chain, so
  // "constructor"/"toString"/"__proto__" would falsely validate as profile ids.
  return Object.hasOwn(PROFILE_DEFINITIONS, value);
}

/** Merge profile overrides with user config overrides (user wins). */
export function resolveProfileRuleOverrides(
  profileId: ProfileId | undefined
): Record<string, "error" | "warn" | "off"> {
  const id = profileId ?? DEFAULT_PROFILE;
  const profile = PROFILE_DEFINITIONS[id];

  return { ...(profile.ruleOverrides ?? {}) };
}

export function resolveProfileExtraPacks(
  profileId: ProfileId | undefined
): readonly string[] {
  const id = profileId ?? DEFAULT_PROFILE;
  const profile = PROFILE_DEFINITIONS[id];

  return profile.extraPacks ?? [];
}

export function resolveProfileMetaRuleOverrides(
  profileId: ProfileId | undefined
): Record<string, "error"> {
  const id = profileId ?? DEFAULT_PROFILE;
  const profile = PROFILE_DEFINITIONS[id];
  const result: Record<string, "error"> = {};

  for (const ruleId of profile.metaRulesAtError ?? []) {
    result[ruleId] = "error";
  }

  return result;
}

export function mergeRuleOverrides(
  profileId: ProfileId | undefined,
  userOverrides: Readonly<Record<string, "error" | "warn" | "off">>
): Record<string, "error" | "warn" | "off"> {
  return {
    ...resolveProfileRuleOverrides(profileId),
    ...userOverrides,
  };
}
