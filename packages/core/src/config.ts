/**
 * The ONLY module in the harness library that reads `process.env` for runtime
 * flags. Centralizing the names + parsing keeps `=== "1"` magic strings out of
 * the loop and makes every knob discoverable here. Flags are read LIVE (on each
 * call, not at import) so per-run/test env changes take effect.
 *
 * (Scripts under `scripts/` legitimately read their own env directly — they're
 * operational entry points, not library code.)
 */
const FLAG_ON = "1";

/** The env var names the harness recognizes. */
export const ENV_FLAG = {
  noLspTools: "TSFORGE_NO_LSP_TOOLS",
  legacyFeedback: "TSFORGE_LEGACY_FEEDBACK",
  noAstgrep: "TSFORGE_NO_ASTGREP",
} as const;

function isOn(name: string): boolean {
  return process.env[name] === FLAG_ON;
}

export const flags = {
  /** Withhold the LSP nav tool set even on existing-code runs (A/B control). */
  noLspTools: (): boolean => isOn(ENV_FLAG.noLspTools),
  /** Force the legacy (mis-selected) gate-feedback parser (A/B control). */
  legacyFeedback: (): boolean => isOn(ENV_FLAG.legacyFeedback),
  /** Disable the ast-grep safe-idiom rewrite pass in settleGate (A/B control). */
  noAstgrep: (): boolean => isOn(ENV_FLAG.noAstgrep),
};
