/**
 * Harness-authored `role: "user"` turns — real model context, not human speech.
 * Resume / transcript paint must not label these as USER cards.
 */

/** Checklist injects / Phase B nudges — Tasks rail already owns that UI. */
export function isEphemeralUserInject(message: {
  readonly role: string;
  readonly content: string;
}): boolean {
  if (message.role !== "user") {
    return false;
  }

  const content = message.content;

  return (
    content.startsWith("[checklist — session plan ") ||
    content.startsWith("Gate is GREEN but the approved checklist")
  );
}

/**
 * Distinctive leading text of every harness→model inject that is stored as
 * `role: "user"` (gate feedback, near-green banners, resteers, nudges).
 * Keep in sync when those strings change.
 */
const HARNESS_USER_PREFIXES: readonly string[] = [
  "⚠ NEAR-GREEN",
  "⚠ REGRESSION",
  "⚠ generation interrupted",
  "The acceptance command still fails:",
  "You are only one or two errors from done",
  "You replied with text but called no tool",
  "STOP — you wrote file contents",
  "Your plan is APPROVED",
  "Your previous response timed out",
  "You started repeating yourself",
  "You have made many tool calls",
  "NOTE: automatic fixers",
  "An expert engineer just repaired",
];

/** True when this user-role message was written by the harness, not the human. */
export function isHarnessUserInject(message: {
  readonly role: string;
  readonly content: string;
}): boolean {
  if (message.role !== "user") {
    return false;
  }

  if (isEphemeralUserInject(message)) {
    return true;
  }

  const content = message.content;

  if (HARNESS_USER_PREFIXES.some((p) => content.startsWith(p))) {
    return true;
  }

  // Banner + feedback: NEAR-GREEN / REGRESSION lines precede the acceptance block.
  return content.includes("\nThe acceptance command still fails:");
}
