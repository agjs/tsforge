import {
  isDefaultConventions,
  pickValidConventions,
  resolveConventions,
} from "./conventions";
import type { IConventions } from "./conventions.types";
import type {
  EslintSurface,
  IConventionRuleEntries,
  RuleEntry,
  RuleSeverity,
} from "./eslint-conventions.types";
import { isRecord } from "../lib/guards";

/**
 * The single builder that turns resolved {@link IConventions} into the ESLint rule
 * OPTIONS the bundled `.mjs` configs (and the brought constitution) splice in. This
 * is why "bare PascalCase" or "allow enums" can be expressed at all: `applyOverrides`
 * (rule-packs) is severity-only and CANNOT rewrite a rule's options — only this
 * builder can. Every gate surface calls it, so the gate, the write-time linter, and
 * the brought constitution can never disagree on what a convention means.
 *
 * SAFETY IS STRUCTURAL HERE: the `as`/`<>` cast bans on the web surface live inside
 * `no-restricted-syntax`, and this builder ALWAYS emits them regardless of the enum
 * choice — so "allow enums" can never remove a cast ban. The core surface bans casts
 * via the separate `consistent-type-assertions` rule, which this builder never touches.
 */

// Exact messages preserved from the bundled configs so gate output is unchanged.
const ENUM_MESSAGE = "Use 'as const' object literals instead of enums.";
const AS_CAST_MESSAGE =
  "No `as` type casts — type it properly (annotate, narrow, or guard). `as const` is allowed.";
const ANGLE_CAST_MESSAGE =
  "No angle-bracket type assertions — type it properly. `as const` is allowed.";

// The value-changing cast selectors — SAFETY, always on the web surface.
const CAST_SELECTORS: readonly unknown[] = [
  {
    selector: "TSAsExpression[typeAnnotation.typeName.name!='const']",
    message: AS_CAST_MESSAGE,
  },
  { selector: "TSTypeAssertion", message: ANGLE_CAST_MESSAGE },
];

const ENUM_SELECTOR = { selector: "TSEnumDeclaration", message: ENUM_MESSAGE };

/** Build the `@typescript-eslint/naming-convention` entry, or undefined to omit it
 *  (interface naming "off"). The WEB surface always uses BARE PascalCase (React/
 *  shadcn/TanStack name interfaces `Props`, not `IProps` — requiring the `I`-prefix
 *  there just makes the model fight its training data every scaffold). Core/library
 *  code still gets the `I`-prefix when conventions ask for it. Bare PascalCase also
 *  already permits library-mandated names (e.g. TanStack's `Register`), so the web
 *  surface needs no name filter. */
function namingRule(
  conventions: IConventions,
  surface: EslintSurface
): RuleEntry | undefined {
  if (conventions.interfaces === "off") {
    return undefined;
  }

  const selector: Record<string, unknown> = {
    selector: "interface",
    format: ["PascalCase"],
  };

  if (surface === "web") {
    return ["error", selector];
  }

  if (conventions.interfaces === "i-prefix") {
    selector.prefix = ["I"];
  }

  return ["error", selector];
}

/** Build the `no-restricted-syntax` entry, or undefined to omit it. Enum ban is the
 *  taste part; the web cast selectors are the SAFETY part and are always included. */
function noRestrictedSyntaxRule(
  conventions: IConventions,
  surface: EslintSurface
): RuleEntry | undefined {
  const selectors: unknown[] = [];

  if (conventions.enums === "ban") {
    selectors.push(ENUM_SELECTOR);
  }

  if (surface === "web") {
    selectors.push(...CAST_SELECTORS);
  }

  if (selectors.length === 0) {
    return undefined;
  }

  return ["error", ...selectors];
}

/** The two convention-managed rule entries for a surface — keys present only when
 *  the convention keeps that rule on. The bundled config must NOT carry its own
 *  hardcoded `naming-convention`/`no-restricted-syntax`; it splices these instead. */
export function conventionRuleEntries(
  conventions: IConventions,
  surface: EslintSurface
): IConventionRuleEntries {
  const entries: {
    "@typescript-eslint/naming-convention"?: RuleEntry;
    "no-restricted-syntax"?: RuleEntry;
  } = {};

  const naming = namingRule(conventions, surface);

  if (naming !== undefined) {
    entries["@typescript-eslint/naming-convention"] = naming;
  }

  const nrs = noRestrictedSyntaxRule(conventions, surface);

  if (nrs !== undefined) {
    entries["no-restricted-syntax"] = nrs;
  }

  return entries;
}

/** The JSON value for the `TSFORGE_CONVENTIONS` gate-command env, or undefined to
 *  OMIT it — a default convention set emits nothing, so a default project's gate
 *  command is unchanged. The bundled `.mjs` parses this with {@link parseConventionsEnv}. */
export function conventionsEnvValue(
  conventions: IConventions | undefined
): string | undefined {
  if (conventions === undefined || isDefaultConventions(conventions)) {
    return undefined;
  }

  return JSON.stringify(conventions);
}

/** The convention-managed rules as an EXPLICIT record for the in-process write-time
 *  linter's `overrideConfig` (which layers over the bundled `.mjs`). Unlike
 *  {@link conventionRuleEntries}, a disabled rule is set to `"off"` (not omitted) so
 *  the override actually disables the bundled config's copy. */
export function conventionOverrideRules(
  conventions: IConventions,
  surface: EslintSurface
): Record<string, RuleEntry> {
  const entries = conventionRuleEntries(conventions, surface);

  return {
    "@typescript-eslint/naming-convention":
      entries["@typescript-eslint/naming-convention"] ?? "off",
    "no-restricted-syntax": entries["no-restricted-syntax"] ?? "off",
  };
}

/** Parse the JSON `TSFORGE_CONVENTIONS` env channel into a fully-resolved set,
 *  tolerating junk (any unset/invalid field falls back to the house default). */
export function parseConventionsEnv(raw: string | undefined): IConventions {
  if (raw === undefined || raw.length === 0) {
    return resolveConventions(undefined);
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    // Validate field-by-field: a null/garbage value must FALL BACK to the house
    // default, never overwrite it (which would silently loosen a convention).
    return resolveConventions(
      isRecord(parsed) ? pickValidConventions(parsed) : undefined
    );
  } catch {
    return resolveConventions(undefined);
  }
}

/**
 * Bundled safety/convention rules that the severity channel (`TSFORGE_RULE_OVERRIDES`)
 * may NEVER weaken or disable. Two groups, one guarantee — overrides can't touch them:
 *  • Safety floor: real-bug catchers (`any`, casts, `!`, complexity, `===`, var/const).
 *  • Convention-managed: naming + `no-restricted-syntax` are tuned via conventions,
 *    not by disabling the whole rule (which would also drop the cast ban).
 * The guard is SURFACE-AWARE: it only protects a rule that the surface already has;
 * it never ADDS a rule a surface lacks (e.g. type-aware rules absent from the `.mjs`).
 */
export const PROTECTED_BUNDLED_RULES: ReadonlySet<string> = new Set([
  "@typescript-eslint/no-explicit-any",
  "@typescript-eslint/no-non-null-assertion",
  "@typescript-eslint/consistent-type-assertions",
  "@typescript-eslint/strict-boolean-expressions",
  "@typescript-eslint/naming-convention",
  "eqeqeq",
  "no-var",
  "prefer-const",
  "no-restricted-syntax",
  "sonarjs/cognitive-complexity",
]);

function withSeverity(entry: RuleEntry, severity: RuleSeverity): RuleEntry {
  if (typeof entry === "string") {
    return severity;
  }

  return [severity, ...entry.slice(1)];
}

/**
 * Apply `TSFORGE_RULE_OVERRIDES` to a surface's BUNDLED rules, honoring the
 * protected set. A protected rule's override is ignored (safety/conventions stay
 * intact); any other rule may be downgraded or dropped (`"off"`). Override keys are
 * matched bare or `tsforge/`-prefixed. Unknown override keys (rules not on this
 * surface) are simply not applied — never added.
 */
export function applyBundledOverrides(
  rules: Readonly<Record<string, RuleEntry>>,
  overrides: Readonly<Record<string, RuleSeverity>> | undefined
): Record<string, RuleEntry> {
  if (overrides === undefined) {
    return { ...rules };
  }

  const out: Record<string, RuleEntry> = {};

  for (const [name, entry] of Object.entries(rules)) {
    const bare = name.startsWith("tsforge/") ? name.slice(8) : name;
    const override = overrides[name] ?? overrides[bare];

    if (override === undefined || PROTECTED_BUNDLED_RULES.has(name)) {
      out[name] = entry;
    } else if (override !== "off") {
      // "off" drops the rule by omission; protected rules never reach here.
      out[name] = withSeverity(entry, override);
    }
  }

  return out;
}
