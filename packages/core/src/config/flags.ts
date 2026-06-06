import { FLAG_ON, ENV_FLAG } from "./config.constants";

/**
 * The ONLY module that reads `process.env` for runtime flags. Read LIVE (on each
 * call, not at import) so per-run/test env changes take effect. (Scripts read
 * their own env directly — they're operational entry points, not library code.)
 */
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
