import { DECISION_BRIEF_MAX_CHARS } from "./provider.types";

/** Trim recall text to the injection budget; empty → null. */
export function formatDecisionBrief(
  raw: string | null,
  maxChars: number = DECISION_BRIEF_MAX_CHARS
): string | null {
  if (raw === null) {
    return null;
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Build the system-prompt block, or empty string when there is no brief. */
export function decisionBriefBlock(brief: string | null): string {
  if (brief === null || brief.length === 0) {
    return "";
  }

  return `Project decision memory:\n${brief}\n\n`;
}

/** Curated retain payload for a finished feature or interactive turn. */
export function buildDecisionRetainText(input: {
  readonly kind: "feature" | "session";
  readonly summary: string;
  readonly details?: readonly string[];
}): string | null {
  const summary = input.summary.trim();

  if (summary.length === 0) {
    return null;
  }

  const lines = [
    input.kind === "feature"
      ? `Feature verified: ${summary}`
      : `Session decision: ${summary}`,
  ];

  if (input.details !== undefined) {
    for (const detail of input.details) {
      const d = detail.trim();

      if (d.length > 0) {
        lines.push(`- ${d}`);
      }
    }
  }

  return lines.join("\n");
}
