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
  /** Withhold the read-only `git_context` tool on existing-code runs (default ON;
   *  set to "1" to force off, e.g. for eval sweeps or non-git workspaces). */
  noGitTool: (): boolean => isOn(ENV_FLAG.noGitTool),
  /** Fall back to basic readline input (no multiline editor) in interactive mode.
   *  Default OFF — the editor is on. Set to "1" to disable the editor. */
  basicInput: (): boolean => isOn(ENV_FLAG.basicInput),
  /** Withhold model-driven delegation (the `spawn_agent` tool + specialists).
   *  Default OFF — delegation is on. Set to "1" for the A/B control arm (measure
   *  the harness WITHOUT subagents) or to force a pure single-stream run. */
  noDelegation: (): boolean => isOn(ENV_FLAG.noDelegation),
  /** Enable the EXPERT HANDOFF: when a build stalls after the full steering ladder,
   *  hand the blocking file to the configured `capabilities.expert` model. Opt-in
   *  (default OFF) because it makes a live, paid, non-deterministic API call — so
   *  unit tests and eval sweeps that drive a run to a stall never hit it unless they
   *  explicitly ask. Real autonomous builders (the headless web builder, interactive
   *  sessions) turn it on. Without it, a stall parks with all work kept, as before. */
  expertRescue: (): boolean => isOn(ENV_FLAG.expertRescue),
  /** WS-B near-green checkpoint/rollback: when the build reaches a near-green low (1..N
   *  errors) snapshot the scope files, and if the next gate SPRAYS past it (curr >
   *  checkpoint + M) revert to that best instead of letting the model build on the
   *  regression. DEFAULT ON — it's the fix for the near-green oscillation that thrashes real
   *  builds (Phase 0a), and it's deterministic (no network), so every build should get it
   *  without knowing a flag exists. Kill-switch TSFORGE_NO_NEAR_GREEN_CHECKPOINT=1 disables
   *  it (A/B control / escape hatch). Thresholds N=2, M=3 from Phase 0a. */
  nearGreenCheckpoint: (): boolean => !isOn(ENV_FLAG.noNearGreenCheckpoint),
  /** WS-B near-green ROTATION steer (#77): when the build sits at a near-green count but the
   *  SPECIFIC error set rotates for several cycles (the model fixes one error and the fix spawns
   *  another — e.g. extracts a component → its siblings/tests are now missing), inject a
   *  completion-only steer ("finish the files that already have errors; don't create new
   *  files/modules unless the same edit adds their siblings + tests"). This is the last-mile gap
   *  that made green non-deterministic (build17 parked on it; build16 crossed by luck). Count-only
   *  WS-B can't see it (the count never sprays). DEFAULT ON, deterministic (no network); kill with
   *  TSFORGE_NO_NEAR_GREEN_ROTATION=1. Generic — keyed only on rule/file, no stack knowledge. */
  nearGreenRotation: (): boolean => !isOn(ENV_FLAG.noNearGreenRotation),
};
