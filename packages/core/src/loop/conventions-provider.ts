/**
 * Generic CONVENTION-PROVIDER seam. A build ADAPTER (e.g. boringstack) ships a
 * "how to write it right" convention library; this interface lets the adapter INJECT
 * that library into the core session/turn via `ISessionConfig.conventions`, so the
 * core loop never imports stack-specific convention CONTENT. A session with no
 * provider (a plain/scratch build, or a future non-web adapter) simply carries no
 * conventions — exactly as intended. Mirrors the other injected seams (`IGate`,
 * `Exec`, `IPlanConstraints`): the capability is core, the content is the adapter's.
 */
export interface IConventionProvider {
  /** The full front-loaded guide text (was `buildConventionGuides`). */
  buildGuides(): string;
  /** Reactive PUSH: guides for gate errors not yet seen this run (was
   *  `unseenGuidesForErrors`). Mutates `seen` to dedupe per run. */
  unseenForErrors(
    errors: readonly { readonly rule?: string }[],
    seen: Set<string>
  ): string[];
  /** On-demand PULL lookup for one topic; null for an unknown topic. */
  guide(topic: string): string | null;
  /** The valid topic ids (for the `pull_conventions` tool's help text). */
  topics(): readonly string[];
  /** Whether a string is a known topic. */
  isTopic(s: string): boolean;
}
