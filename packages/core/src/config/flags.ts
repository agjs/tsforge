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
  /** FORCED-TOOLS experiment (A/B, default off): every gated-build turn runs
   *  with tool_choice "required" + a `yield_status` stop tool, so output is
   *  always grammar-constrained — the malformed-tool-call class can't occur. */
  forceTools: (): boolean => isOn(ENV_FLAG.forceTools),
  /** Hashline edit tool (content-hash-anchored line edits) with snapshot recovery
   *  (A/B control, default ON — set to "0" to disable). */
  hashlineEditTool: (): boolean => process.env.TSFORGE_HASHLINE !== "0",
  /** TTSR stream-interrupting rules (A/B control, default ON — set to "0" to disable). */
  ttsr: (): boolean => process.env.TSFORGE_TTSR !== "0",
  /** Instant per-file type diagnostics appended to edit/create tool results
   *  (A/B control, default ON — set to "0" to disable). */
  lspWriteFeedback: (): boolean =>
    process.env.TSFORGE_LSP_WRITE_FEEDBACK !== "0",
  /** Scratch-utility simplicity guidance — appends a "shortest correct solution"
   *  block to the build prompt for from-scratch, non-web tasks (A/B control,
   *  default OFF until a sweep validates it). */
  simplicity: (): boolean => isOn(ENV_FLAG.simplicity),
  /** TDD-first mode: appends test-first guidance to the build prompt AND elevates
   *  the `test-sibling-required` meta-rule to an ERROR — so a logic file the agent
   *  TOUCHES without a test fails the gate (the harness obsesses over tests, not
   *  just suggests them). Quality + strictness out of the box, so DEFAULT ON; set
   *  TSFORGE_TDD=0 to opt out. The error is scoped to changed files (see the rule),
   *  so it never blocks on a repo's pre-existing untested code. */
  tdd: (): boolean => process.env.TSFORGE_TDD !== "0",
  /** Free, local web access (web_fetch + web_search) — opt-in (default OFF) so
   *  eval sweeps stay deterministic and offline. No key, no paid service:
   *  web_fetch extracts locally; web_search uses DuckDuckGo (or a self-hosted
   *  SearXNG via TSFORGE_SEARXNG_URL). */
  webTools: (): boolean => isOn(ENV_FLAG.webTools),
  /** Programmatic Tool Calling: advertise the `script` tool. ON by default — it
   *  measurably speeds up read-dependent multi-file work (codemods) and is a no-op
   *  on simple tasks; withhold with TSFORGE_NO_SCRIPT (the A/B / kill switch). It
   *  makes no network calls, so default-on keeps eval sweeps deterministic. */
  scriptTool: (): boolean => !isOn(ENV_FLAG.noScriptTool),
  /** Disable the startup "update available" npm-registry check (default ON, i.e.
   *  the check runs only in interactive non-CI sessions). Set to "1" for offline
   *  environments or to silence the notice. */
  noUpdateCheck: (): boolean => isOn(ENV_FLAG.noUpdateCheck),
  /** Withhold the read-only `git_context` tool on existing-code runs (default ON;
   *  set to "1" to force off, e.g. for eval sweeps or non-git workspaces). */
  noGitTool: (): boolean => isOn(ENV_FLAG.noGitTool),
  /** Fall back to basic readline input (no multiline editor) in interactive mode.
   *  Default OFF — the editor is on. Set to "1" to disable the editor. */
  basicInput: (): boolean => isOn(ENV_FLAG.basicInput),
};
