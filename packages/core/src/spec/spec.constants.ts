/** Spec run mode — compare against these, never the bare string. */
export const SPEC_MODE = {
  scratch: "scratch",
  existing: "existing",
} as const;

/** Verdict on a generated test — compare against these, never the bare string. */
export const FINDING_KIND = {
  unsatisfiable: "unsatisfiable",
  overStrict: "over-strict",
  ambiguous: "ambiguous",
  ok: "ok",
} as const;
