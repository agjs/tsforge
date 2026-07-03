/** The "flag on" sentinel + the env var names the harness recognizes. */
export const FLAG_ON = "1";

export const ENV_FLAG = {
  noLspTools: "TSFORGE_NO_LSP_TOOLS",
  tdd: "TSFORGE_TDD",
  webTools: "TSFORGE_WEB",
  noScriptTool: "TSFORGE_NO_SCRIPT",
  noUpdateCheck: "TSFORGE_NO_UPDATE_CHECK",
  noGitTool: "TSFORGE_NO_GIT_TOOL",
  basicInput: "TSFORGE_BASIC_INPUT",
} as const;
