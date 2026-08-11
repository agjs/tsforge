/**
 * Runtime PROJECT DECISION memory provider — product/architecture choices in a
 * user-hosted backend. Separate from Phase 1 failure→fix TTSR.
 */

export type {
  MemoryProviderKind,
  IHttpMemoryProviderConfig,
  IMcpMemoryProviderConfig,
  IMemoryProviderConfig,
} from "../../config/memory-provider.types";

/** Runtime provider: fail-soft (never throws into the session loop). */
export interface IMemoryProvider {
  readonly bankId: string;
  recall(query: string): Promise<string | null>;
  retain(content: string): Promise<void>;
  list(): Promise<readonly string[]>;
  forget(): Promise<void>;
}

/** Default recall query when loading a session brief. */
export const DECISION_RECALL_QUERY =
  "Stable product and architecture decisions for this codebase. Prefer latest.";

/** Context tag sent to HTTP backends on retain. */
export const DECISION_CONTEXT = "tsforge-decision";

/** Soft cap for injected decision brief (characters ≈ tokens×4). ~600 tokens. */
export const DECISION_BRIEF_MAX_CHARS = 2400;
