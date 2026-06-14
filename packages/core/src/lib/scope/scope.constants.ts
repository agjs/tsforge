/** A throwaway prefix the model may always write to — `scratch/` experiments are
 *  ignored by the gate, so it can test hypotheses by running code. */
export const SCRATCH_PREFIX = "scratch/";

/**
 * VENDORED, harness-authored files the model must NEVER edit or create. These are
 * tested, already-type-correct SDK/primitive/generated files: the web scaffold's
 * `src/lib/**` toolkit, the `src/components/ui/**` primitives, the MSW mock
 * machinery (`src/mocks/db.ts` + `src/mocks/browser.ts`), and any `*.gen.ts`
 * codegen output (TanStack's route tree). They are eslint- and prettier-ignored,
 * so a model that touches them sees tsc errors it cannot fix and — with
 * eslint-disable + `@ts-*` suppressions banned — has no escape, looping to the
 * turn cap. A write to any of these is rejected: a type error involving them is
 * always a wrong CALL SITE, never the library. (`src/mocks/handlers.ts` is NOT
 * vendored — the model registers its mock resources there.)
 */
export const VENDORED_PATTERNS = [
  "src/lib/**",
  "src/components/ui/**",
  "src/mocks/db.ts",
  "src/mocks/browser.ts",
  "**/*.gen.ts",
] as const;
