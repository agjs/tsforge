/** Adoption tier: safety rules default on; architecture rules opt-in via profile. */
export type RuleTier = "safety" | "framework" | "architecture" | "experimental";

export type FalsePositiveRisk = "low" | "medium" | "high";

/** Catalog metadata for a single ESLint pack rule or meta-rule. */
export interface IRuleCatalogEntry {
  readonly tier: RuleTier;
  readonly tags?: readonly string[];
  readonly falsePositiveRisk?: FalsePositiveRisk;
  readonly requiresTypeInfo?: boolean;
  readonly profiles?: readonly ProfileId[];
}

export type ProfileId = "recommended" | "strict" | "security" | "opinionated";
