import type { IConventions } from "./conventions.types";

/**
 * Convention → PROMPT phrasing. The gate channel (eslint-conventions) decides what
 * PASSES; this decides what the model is TOLD. Both read the same resolved
 * {@link IConventions}, so the model is never told "I-prefix" while the gate accepts
 * bare names (the inconsistency the setup feature exists to remove). Safety rules
 * (`as`/`any`/`!`, complexity) are NOT expressed here — they are unconditional in
 * the prompts and never vary by convention.
 */

/** The interface-naming clause for prompts, or null when naming is unenforced
 *  ("off") so the prompt simply omits any interface-naming instruction. */
export function interfaceNamingPhrase(
  conventions: IConventions
): string | null {
  switch (conventions.interfaces) {
    case "i-prefix":
      return "interfaces are `I`-prefixed";
    case "bare-pascal-case":
      return "interfaces are PascalCase with NO `I` prefix";
    case "off":
      return null;
  }
}

/** Where a logic file's test must live — used by the TDD/test guidance so the
 *  model writes the test in the layout the gate actually accepts. */
export function testLayoutPhrase(conventions: IConventions): string {
  switch (conventions.tests) {
    case "co-located":
      return "a co-located `*.test.ts` sibling";
    case "mirrored":
      return "a mirrored `tests/` file";
    case "either":
      return "a co-located `*.test.ts` sibling (or a mirrored `tests/` file)";
  }
}
