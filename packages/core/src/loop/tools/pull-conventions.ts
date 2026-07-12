import { str } from "./tool-context";
import {
  conventionGuide,
  conventionTopics,
  isConventionTopic,
} from "../conventions";

/**
 * The `pull_conventions` tool handler — the PULL half of the convention layer. The
 * model fetches the boringstack how-to for a topic ON DEMAND (before writing that
 * kind of code), the complement to the harness PUSHing guides on first violation.
 * Pure lookup; no ctx needed (fewer params is assignable to ToolHandler).
 */
export function doPullConventions(args: Record<string, unknown>): string {
  const topic = str(args, "topic");

  if (!isConventionTopic(topic)) {
    return (
      `pull_conventions: unknown topic "${topic}". ` +
      `Valid topics: ${conventionTopics().join(", ")}.`
    );
  }

  return conventionGuide(topic);
}
