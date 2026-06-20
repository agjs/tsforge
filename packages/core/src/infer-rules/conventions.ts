import type {
  ComponentFoldersConvention,
  EnumConvention,
  IConventions,
  InterfaceConvention,
  TestConvention,
} from "./conventions.types";

/** Allowed values per field — the single source for validation AND wizard menus. */
export const INTERFACE_CONVENTIONS = [
  "i-prefix",
  "bare-pascal-case",
  "off",
] as const;
export const ENUM_CONVENTIONS = ["ban", "allow"] as const;
export const TEST_CONVENTIONS = ["co-located", "mirrored", "either"] as const;
export const COMPONENT_FOLDER_CONVENTIONS = [
  "tsforge-views",
  "repo",
  "warn",
] as const;

/**
 * The defaults that REPRODUCE tsforge's current house style exactly, so a repo
 * with no `conventions` block behaves identically to before this feature:
 * I-prefixed interfaces, enums banned, the React `src/views/` layout. `tests` is
 * `either` because the test-sibling gate already accepts both a co-located sibling
 * and a `tests/` mirror — defaulting to a single layout would TIGHTEN the gate.
 */
export const DEFAULT_CONVENTIONS: IConventions = {
  interfaces: "i-prefix",
  enums: "ban",
  tests: "either",
  componentFolders: "tsforge-views",
};

const INTERFACE_SET = new Set<string>(INTERFACE_CONVENTIONS);
const ENUM_SET = new Set<string>(ENUM_CONVENTIONS);
const TEST_SET = new Set<string>(TEST_CONVENTIONS);
const COMPONENT_FOLDER_SET = new Set<string>(COMPONENT_FOLDER_CONVENTIONS);

export function isInterfaceConvention(v: unknown): v is InterfaceConvention {
  return typeof v === "string" && INTERFACE_SET.has(v);
}

export function isEnumConvention(v: unknown): v is EnumConvention {
  return typeof v === "string" && ENUM_SET.has(v);
}

export function isTestConvention(v: unknown): v is TestConvention {
  return typeof v === "string" && TEST_SET.has(v);
}

export function isComponentFoldersConvention(
  v: unknown
): v is ComponentFoldersConvention {
  return typeof v === "string" && COMPONENT_FOLDER_SET.has(v);
}

/** Fill any unset field from {@link DEFAULT_CONVENTIONS}, yielding a fully-decided
 *  set. This is THE function every consumer (gate, linter, prompts) calls so they
 *  all agree on the same resolved choices. */
export function resolveConventions(
  partial: Readonly<Partial<IConventions>> | undefined
): IConventions {
  return { ...DEFAULT_CONVENTIONS, ...partial };
}

/** True when every field equals the house default — used to SKIP emitting the
 *  `TSFORGE_CONVENTIONS` env/override, so a default project's gate command and
 *  prompts are byte-identical to before this feature existed. */
export function isDefaultConventions(conventions: IConventions): boolean {
  return (
    conventions.interfaces === DEFAULT_CONVENTIONS.interfaces &&
    conventions.enums === DEFAULT_CONVENTIONS.enums &&
    conventions.tests === DEFAULT_CONVENTIONS.tests &&
    conventions.componentFolders === DEFAULT_CONVENTIONS.componentFolders
  );
}
