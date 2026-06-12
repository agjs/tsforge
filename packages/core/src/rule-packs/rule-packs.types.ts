import type { TSESLint } from "@typescript-eslint/utils";

/** A single ESLint rule pack, bundling multiple related rules with their configuration. */
export interface IRulePack {
  /** Unique identifier for this pack; must match a PACK_REGISTRY id from ../stack-detection. */
  readonly id: string;

  /** Human-readable description of what this pack enforces. */
  readonly description: string;

  /** ESLint rule module definitions, indexed by unprefixed rule name. */
  readonly rules: Readonly<
    Record<string, TSESLint.RuleModule<string, readonly unknown[]>>
  >;

  /** Default severity for each rule in the pack, indexed by unprefixed rule name. */
  readonly rulesConfig: Readonly<Record<string, "error" | "warn">>;
}
