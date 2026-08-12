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
  /**
   * Queue/write a decision. Returns `true` when the backend accepted the write
   * (or there was nothing to send after redaction). `false` on transport /
   * HTTP failure — callers should surface that; silent drops hide a dead bank.
   */
  retain(content: string): Promise<boolean>;
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

/**
 * Per-request deadline for any memory backend call.
 *
 * `recall` runs BEFORE the session is constructed, so an unbounded request
 * hangs the CLI at start-up with no output. A backend that refuses the
 * connection fails instantly; one that accepts it and never answers (loaded
 * host, proxy holding the socket, paused VM) is what this covers.
 */
export const MEMORY_REQUEST_TIMEOUT_MS = 3000;

/**
 * Ceiling for the whole start-up load (provider construction + recall). Belt
 * and braces over the per-request deadline: it also bounds the MCP path and any
 * transport that ignores an abort signal.
 */
export const MEMORY_START_TIMEOUT_MS = 5000;
