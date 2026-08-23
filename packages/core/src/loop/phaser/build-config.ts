import type { ExecutionMode } from "../prompt";
import type { IPolicyRules } from "../../policy";
import type { IConventionProvider } from "../conventions-provider";
import { phaserConventionProvider } from "./conventions";

/**
 * Commands the model must NEVER run during a Phaser build. Generators and
 * Playwright smoke are harness-owned (injected exec), not the model's `run` tool.
 */
export const PHASER_NO_DEV_DENY: IPolicyRules = {
  deny: [
    {
      kind: "shell",
      commandPattern:
        "playwright|\\bvite\\b|\\bbun\\s+run\\s+dev\\b|\\bbun\\s+run\\s+new:",
    },
  ],
};

export const PHASER_SLICE_GUIDANCE =
  "You are filling ONE Phaser slice. The files are already generated and wired. " +
  "Edit only the scoped files. Domain stays Phaser-free. Tests are co-located. " +
  "The architecture brief is already in the system prompt — do not list or search src/ to re-orient. " +
  "import * as Phaser from 'phaser'. Never ignoreDestroy. Never construct GameObjects in update.";

export const PHASER_BUILD_SESSION: {
  readonly executionMode: ExecutionMode;
  readonly guidance: string;
  readonly pullConventions: true;
  readonly conventions: IConventionProvider;
  readonly offerCheck: true;
  readonly policyRules: IPolicyRules;
} = {
  executionMode: "drive-to-green",
  guidance: PHASER_SLICE_GUIDANCE,
  pullConventions: true,
  conventions: phaserConventionProvider,
  offerCheck: true,
  policyRules: PHASER_NO_DEV_DENY,
};
