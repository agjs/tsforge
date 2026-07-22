/** The "flag on" sentinel + the env var names the harness recognizes. */
export const FLAG_ON = "1";

export const ENV_FLAG = {
  noLspTools: "TSFORGE_NO_LSP_TOOLS",
  tdd: "TSFORGE_TDD",
  webTools: "TSFORGE_WEB",
  noScriptTool: "TSFORGE_NO_SCRIPT",
  noGitTool: "TSFORGE_NO_GIT_TOOL",
  basicInput: "TSFORGE_BASIC_INPUT",
  noDelegation: "TSFORGE_NO_DELEGATION",
  expertRescue: "TSFORGE_EXPERT_RESCUE",
  noNearGreenCheckpoint: "TSFORGE_NO_NEAR_GREEN_CHECKPOINT",
  noE2eAcceptance: "TSFORGE_NO_E2E_ACCEPTANCE",
} as const;
