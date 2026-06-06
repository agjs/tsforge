/** Why an edit failed to apply (compare against these, never the bare string). */
export const EDIT_FAIL_REASON = {
  missingFile: "missing-file",
  notFound: "not-found",
  ambiguous: "ambiguous",
} as const;

/** Why a create failed (compare against this, never the bare string). */
export const CREATE_FAIL_REASON = {
  exists: "exists",
} as const;
