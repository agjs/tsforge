/** The "flag on" sentinel + the env var names the harness recognizes. */
export const FLAG_ON = "1";

export const ENV_FLAG = {
  noLspTools: "TSFORGE_NO_LSP_TOOLS",
  legacyFeedback: "TSFORGE_LEGACY_FEEDBACK",
  noAstgrep: "TSFORGE_NO_ASTGREP",
  forceTools: "TSFORGE_FORCE_TOOLS",
} as const;
