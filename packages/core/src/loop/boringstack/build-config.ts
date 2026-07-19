import type { ExecutionMode } from "../prompt";

/**
 * The BoringStack build's fixed Session flags — spread into `Session.create` by the
 * headless build driver. Extracted here (domain content belongs in loop/boringstack,
 * not the script) so the wiring is UNIT-TESTABLE: dropping a flag silently un-offers
 * a tool, and a Session/advertisement test alone can't catch a headless regression.
 *
 * - `executionMode`: the strict expert-TS drive-to-green contract from the first token.
 * - `guidance`: the per-resource framing (edit only the named files; real domain logic).
 * - `pullConventions`: offer the convention library the model can fetch on demand.
 * - `offerCheck`: offer the callable, structured `check` tool (WS-G) — the per-slice
 *   gate is injected via setGate, and check runs THAT gate mid-turn.
 */
export const BORINGSTACK_BUILD_SESSION: {
  readonly executionMode: ExecutionMode;
  readonly guidance: string;
  readonly pullConventions: true;
  readonly offerCheck: true;
} = {
  executionMode: "drive-to-green",
  guidance:
    "You are filling in ONE BoringStack resource at a time. The API resource " +
    "files (schemas/service/types) and its UI feature are already generated and " +
    "wired; edit ONLY the files named in the task, add real domain fields + logic " +
    "(never an `as` cast), and write the required test siblings. Everything else " +
    "is locked.",
  pullConventions: true,
  offerCheck: true,
};
