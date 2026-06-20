/**
 * The four convention choices `tsforge setup` infers from a repo and writes to
 * `tsforge.config.json`. These are TASTE, not safety: each governs a stylistic
 * rule that has no single right answer (interface naming, enums, test layout,
 * component folders). The safety floor (`no any`/`as`/`!`, complexity, etc.) is
 * NEVER expressed here and can never be relaxed through conventions.
 *
 * One resolved `IConventions` object is the single source every surface reads —
 * the gate (eslint rule OPTIONS), the write-time linter, and every prompt — so a
 * choice like "bare PascalCase" can never disagree between what the model is told
 * and what the gate enforces.
 */

/** How interface names are enforced: `IUser` / `User` / no enforcement. */
export type InterfaceConvention = "i-prefix" | "bare-pascal-case" | "off";

/** Whether `enum` declarations are banned (use `as const`) or allowed. Banning
 *  enums NEVER affects the separate `as`-cast ban — they are split deliberately. */
export type EnumConvention = "ban" | "allow";

/** Where a logic file's test lives: beside it, in a `tests/` mirror, or either. */
export type TestConvention = "co-located" | "mirrored" | "either";

/** Frontend component layout: tsforge's `src/views/<Feature>/`, the repo's own
 *  layout, or warn-only. */
export type ComponentFoldersConvention = "tsforge-views" | "repo" | "warn";

/** The fully-resolved convention set (every field decided — defaults applied). */
export interface IConventions {
  readonly interfaces: InterfaceConvention;
  readonly enums: EnumConvention;
  readonly tests: TestConvention;
  readonly componentFolders: ComponentFoldersConvention;
}
