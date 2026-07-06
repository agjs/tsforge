/**
 * Scoped terminal-output routing. The terminal is one resource, but N event
 * streams may write to it (the parent loop today; subagents from Phase B on).
 * Instead of a single undifferentiated text sink, every write is routed by the
 * emitting agent's id: a registered agent sink wins, else the parent sink
 * (the REPL's StatusBar region), else plain stdout. Replaces the old
 * module-level `interactiveStream` latch in cli/logging.ts.
 */

export type OutputSink = (text: string) => void;

export class OutputRouter {
  private parentSink: OutputSink | null = null;
  private readonly agentSinks = new Map<string, OutputSink>();

  /** Install (or clear, with null) the parent stream sink — the REPL's
   *  StatusBar-aware writer. Headless/one-shot runs leave it null (stdout). */
  setParentSink(sink: OutputSink | null): void {
    this.parentSink = sink;
  }

  /** Register a dedicated sink for one subagent's rendered output. */
  setAgentSink(agentId: string, sink: OutputSink): void {
    this.agentSinks.set(agentId, sink);
  }

  /** Remove a subagent's sink (its writes fall back to the parent sink). */
  clearAgentSink(agentId: string): void {
    this.agentSinks.delete(agentId);
  }

  /** Route one rendered chunk: agent sink → parent sink → stdout. */
  route(text: string, agentId?: string): void {
    if (agentId !== undefined) {
      const sink = this.agentSinks.get(agentId);

      if (sink !== undefined) {
        sink(text);

        return;
      }
    }

    if (this.parentSink !== null) {
      this.parentSink(text);

      return;
    }

    process.stdout.write(text);
  }
}
