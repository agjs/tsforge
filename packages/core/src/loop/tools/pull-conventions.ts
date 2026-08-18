import { str } from "./tool-context";
import type { IToolContext } from "./tool-context";

/**
 * The `pull_conventions` tool handler — the PULL half of the convention layer. The
 * model fetches the stack's how-to for a topic ON DEMAND (before writing that kind of
 * code), the complement to the harness PUSHing guides on first violation. Reads the
 * convention library from the injected `IConventionProvider` (`ctx.conventions`) — the
 * core tool stays stack-agnostic; adapters / house supply the content.
 */
export function doPullConventions(
  args: Record<string, unknown>,
  ctx: Pick<IToolContext, "conventions" | "pulledTopics">
): string {
  const provider = ctx.conventions;

  if (provider === undefined) {
    return "pull_conventions: no convention library is configured for this build.";
  }

  // Comma-list tolerance: one call may fetch several topics ("state, jsx").
  // The schema enums single topics for structured guidance, but dispatch does
  // not strictly validate — batching saves a round-trip per topic.
  const topics = str(args, "topic")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const pulled = (ctx.pulledTopics ??= new Set<string>());
  const blocks: string[] = [];

  for (const topic of topics) {
    const guide = provider.guide(topic);

    if (guide === null) {
      blocks.push(
        `pull_conventions: unknown topic "${topic}". ` +
          `Valid topics: ${provider.topics().join(", ")}.`
      );
      continue;
    }

    pulled.add(topic);
    blocks.push(
      topics.length === 1 ? guide : `=== CONVENTION: ${topic} ===\n${guide}`
    );
  }

  return blocks.length > 0
    ? blocks.join("\n\n")
    : `pull_conventions: no topic given. Valid topics: ${provider.topics().join(", ")}.`;
}
