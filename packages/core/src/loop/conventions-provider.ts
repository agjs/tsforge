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
  /** The full front-loaded guide text injected into the system prompt (was the direct
   *  `buildConventionGuides` call). WS1a consumes only this. The reactive PUSH
   *  (`unseenGuidesForErrors`) and the `pull_conventions` tool still read the library
   *  directly; WS1b migrates them here and this interface grows the matching methods
   *  then — no speculative surface before a consumer exists. */
  buildGuides(): string;
}
