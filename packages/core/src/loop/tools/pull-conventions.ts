import { str } from "./tool-context";
import type { IToolContext } from "./tool-context";

/**
 * The `pull_conventions` tool handler — the PULL half of the convention layer. The
 * model fetches the stack's how-to for a topic ON DEMAND (before writing that kind of
 * code), the complement to the harness PUSHing guides on first violation. Reads the
 * convention library from the injected `IConventionProvider` (`ctx.conventions`) — the
 * core tool stays stack-agnostic; the boringstack adapter supplies the content.
 */
export function doPullConventions(
  args: Record<string, unknown>,
  ctx: Pick<IToolContext, "conventions">
): string {
  const provider = ctx.conventions;

  if (provider === undefined) {
    return "pull_conventions: no convention library is configured for this build.";
  }

  const topic = str(args, "topic");
  const guide = provider.guide(topic);

  if (guide === null) {
    return (
      `pull_conventions: unknown topic "${topic}". ` +
      `Valid topics: ${provider.topics().join(", ")}.`
    );
  }

  return guide;
}
