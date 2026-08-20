/** The "flag on" sentinel + the env var names the harness recognizes. */
export const FLAG_ON = "1";

export const ENV_FLAG = {
  noLspTools: "TSFORGE_NO_LSP_TOOLS",
  tdd: "TSFORGE_TDD",
  webTools: "TSFORGE_WEB",
  noScriptTool: "TSFORGE_NO_SCRIPT",
  noGitTool: "TSFORGE_NO_GIT_TOOL",
  noGithub: "TSFORGE_NO_GITHUB",
  // Linear integration kill-switch, and the escape hatch that re-exposes the raw
  // `mcp__linear__*` tools alongside the curated verbs (off by default).
  noLinear: "TSFORGE_NO_LINEAR",
  linearRaw: "TSFORGE_LINEAR_RAW",
  // Notion + Sentry integrations: same kill-switch + raw-passthrough pair as Linear.
  noNotion: "TSFORGE_NO_NOTION",
  notionRaw: "TSFORGE_NOTION_RAW",
  noSentry: "TSFORGE_NO_SENTRY",
  sentryRaw: "TSFORGE_SENTRY_RAW",
  basicInput: "TSFORGE_BASIC_INPUT",
  noDelegation: "TSFORGE_NO_DELEGATION",
  expertRescue: "TSFORGE_EXPERT_RESCUE",
  noNearGreenCheckpoint: "TSFORGE_NO_NEAR_GREEN_CHECKPOINT",
  noE2eAcceptance: "TSFORGE_NO_E2E_ACCEPTANCE",
  noNearGreenRotation: "TSFORGE_NO_NEAR_GREEN_ROTATION",
} as const;
