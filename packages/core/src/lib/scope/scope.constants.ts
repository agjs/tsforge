/** A throwaway prefix the model may always write to — `scratch/` experiments are
 *  ignored by the gate, so it can test hypotheses by running code. */
export const SCRATCH_PREFIX = "scratch/";

/**
 * VENDORED, harness-authored files the model must NEVER rewrite — the SPECIFIC
 * tested/generated files the web scaffold ships, NOT whole directories. The guard
 * exists for ONE reason: stop the model from "fixing" the generic SDK files
 * (`use-resource`/`api`/`result`/…), whose strict-TS errors are unfixable and —
 * with eslint-disable + `@ts-*` suppressions banned — trap it in a loop. A type
 * error involving one is always a wrong CALL SITE, never the library.
 *
 * Deliberately scoped to exact files so the model stays FREE to do what the
 * guidance tells it: create its own helpers in `src/lib/<name>.ts` and primitives
 * in `src/components/ui/<x>.tsx` (and edit `src/components/ui/button.tsx`). It is
 * also applied ONLY to web-scaffold sessions (via `IToolContext.vendored`), so a
 * normal repo that happens to have a `src/lib/` is never affected. `src/mocks/
 * handlers.ts` is NOT vendored — the model registers its mock resources there.
 */
export const WEB_VENDORED_PATTERNS = [
  "src/lib/utils.ts",
  "src/lib/result.ts",
  "src/lib/object.ts",
  "src/lib/sort.ts",
  "src/lib/api.ts",
  "src/lib/use-resource.ts",
  "src/lib/use-form.ts",
  "src/mocks/db.ts",
  "src/mocks/browser.ts",
  "**/*.gen.ts",
] as const;
