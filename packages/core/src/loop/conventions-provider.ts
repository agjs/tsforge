/**
 * Generic CONVENTION-PROVIDER seam. A build ADAPTER (e.g. boringstack) or the
 * house library ships a "how to write it right" convention library; this interface
 * lets the adapter INJECT that library into the core session/turn via
 * `ISessionConfig.conventions`, so the core loop never imports stack-specific
 * convention CONTENT. A session with no provider (chat / ungated) simply carries
 * no conventions. Mirrors the other injected seams (`IGate`, `Exec`,
 * `IPlanConstraints`): the capability is core, the content is the adapter's.
 */
export interface IConventionProvider {
  /** Short pull-before-first-write contract (+ topic names) for the system prompt.
   *  Must NOT dump full guide bodies — those arrive via `guide()` / pull tool. */
  buildGuides(): string;
  /** Reactive PUSH: the guides for gate-error rules not yet seen this run.
   *  Mutates `seen` to dedupe per run. Backup after red — not a substitute for pull. */
  unseenForErrors(
    errors: readonly { readonly rule?: string; readonly message?: string }[],
    seen: Set<string>
  ): string[];
  /** On-demand PULL: the guide for one topic; null if the topic is unknown. */
  guide(topic: string): string | null;
  /** The valid topic ids (for the `pull_conventions` tool's help text / enum). */
  topics(): readonly string[];
  /** Gate rules backing a topic. Lets the session state which of them the ACTIVE
   *  profile actually fails on, so a guide never promises enforcement it lacks. */
  rulesForTopic(topic: string): readonly string[];
}
