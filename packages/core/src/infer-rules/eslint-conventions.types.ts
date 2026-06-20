/** Which bundled config a rule set is being built for. The web surface keeps its
 *  `as`-cast bans inside `no-restricted-syntax` and exempts TanStack's `Register`
 *  interface; the core surface bans casts via `consistent-type-assertions`. */
export type EslintSurface = "core" | "web";

export type RuleSeverity = "error" | "warn" | "off";

/** An ESLint rule entry: a bare severity, or `[severity, ...options]`. */
export type RuleEntry = RuleSeverity | readonly [RuleSeverity, ...unknown[]];

/** The two convention-managed rule entries the bundled `.mjs` configs splice in.
 *  A key is ABSENT when the convention turns that rule off (so the bundled config
 *  must omit its own hardcoded copy and rely entirely on these). */
export interface IConventionRuleEntries {
  readonly "@typescript-eslint/naming-convention"?: RuleEntry;
  readonly "no-restricted-syntax"?: RuleEntry;
}
