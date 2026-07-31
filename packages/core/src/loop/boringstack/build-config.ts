import type { ExecutionMode } from "../prompt";
import type { IPolicyRules } from "../../policy";
import type { IConventionProvider } from "../conventions-provider";
import { boringstackConventionProvider } from "../conventions";

/**
 * Commands the model must NEVER run during a BoringStack build. The browser end-to-end
 * acceptance is HARNESS-owned (run automatically after the fast gate, with the right port +
 * server reuse). If the model runs it itself — `playwright`, `bun run dev`, `vite`, `dev.sh` —
 * it starts a second host dev server that the scaffold's `preflight-host-dev.sh` guard
 * HARD-EXITS 1 (the dockerized dev server already holds the port). That is an infra guard, not
 * a code error: the model can't fix it, loops on it, and PARKS a feature whose code is already
 * green (observed across build22–24, all 4 slices). Guidance alone did not stop it, so this is a
 * deterministic policy DENY on the model's shell tool. It does NOT affect the harness's own
 * acceptance run, which uses a separate injected exec, not the policy-gated `run` tool.
 */
const NO_BROWSER_E2E_DENY: IPolicyRules = {
  deny: [
    {
      kind: "shell",
      commandPattern: "playwright|\\bvite\\b|\\bbun\\s+run\\s+dev\\b|dev\\.sh",
    },
  ],
};

/**
 * The BoringStack build's fixed Session flags — spread into `Session.create` by the
 * headless build driver. Extracted here (domain content belongs in loop/boringstack,
 * not the script) so the wiring is UNIT-TESTABLE: dropping a flag silently un-offers
 * a tool, and a Session/advertisement test alone can't catch a headless regression.
 *
 * - `executionMode`: the strict expert-TS drive-to-green contract from the first token.
 * - `guidance`: the per-resource framing (edit only the named files; real domain logic).
 * - `pullConventions`: offer the convention library the model can fetch on demand.
 * - `conventions`: INJECT the BoringStack convention library as the generic
 *   `IConventionProvider` seam, so the core loop draws the front-loaded guides from
 *   here instead of importing stack-specific content (core↔adapter seam).
 * - `offerCheck`: offer the callable, structured `check` tool (WS-G) — the per-slice
 *   gate is injected via setGate, and check runs THAT gate mid-turn.
 */
export const BORINGSTACK_BUILD_SESSION: {
  readonly executionMode: ExecutionMode;
  readonly guidance: string;
  readonly pullConventions: true;
  readonly conventions: IConventionProvider;
  readonly offerCheck: true;
  readonly policyRules: IPolicyRules;
} = {
  executionMode: "drive-to-green",
  guidance:
    "You are filling in ONE BoringStack resource at a time. The API resource " +
    "files (schemas/service/types) and its UI feature are already generated and " +
    "wired; edit ONLY the files named in the task, add real domain fields + logic " +
    "(never an `as` cast), and write the required test siblings. Everything else " +
    "is locked.",
  pullConventions: true,
  conventions: boringstackConventionProvider,
  offerCheck: true,
  policyRules: NO_BROWSER_E2E_DENY,
};
