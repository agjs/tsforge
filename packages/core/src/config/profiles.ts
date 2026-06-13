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

/** Architecture-tier rules enabled only in the opinionated profile. */
export const ARCHITECTURE_RULES = [
  "component-folder-structure",
  "no-state-in-component-body",
  "no-inline-jsx-functions",
  "index-must-reexport-default",
  "forwardref-display-name",
  "max-hooks-per-file",
] as const;

const architectureOffOverrides = Object.fromEntries(
  ARCHITECTURE_RULES.map((rule) => [rule, "off" as const])
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
      ...architectureOffOverrides,
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
      ...architectureOffOverrides,
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
    ruleOverrides: architectureOffOverrides,
  },
  frontend: {
    id: "frontend",
    label: "Frontend",
    description: "Recommended with React/Next architecture rules at warn.",
    ruleOverrides: {
      "no-html-img-element": "warn",
      "no-anonymous-useEffect": "warn",
      "no-derived-state-in-effect": "warn",
      ...architectureOffOverrides,
    },
  },
  backend: {
    id: "backend",
    label: "Backend",
    description:
      "Recommended; stack detection adds Fastify/Elysia/Drizzle/BullMQ packs.",
    ruleOverrides: architectureOffOverrides,
  },
  opinionated: {
    id: "opinionated",
    label: "Opinionated",
    description:
      "Full house-style architecture rules including component folder structure.",
    ruleOverrides: {
      "component-folder-structure": "error",
      "no-state-in-component-body": "error",
      "no-inline-jsx-functions": "warn",
      "index-must-reexport-default": "error",
      "forwardref-display-name": "error",
      "max-hooks-per-file": "warn",
      "prefer-early-return": "error",
    },
  },
};

export const DEFAULT_PROFILE: ProfileId = "recommended";

export function isProfileId(value: string): value is ProfileId {
  return value in PROFILE_DEFINITIONS;
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
