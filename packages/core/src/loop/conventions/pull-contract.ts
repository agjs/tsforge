/**
 * Short system-prompt contract for convention PULL — topic names only, never
 * full guide bodies. Full text arrives via `pull_conventions` (or one matching
 * PUSH after a gate red).
 */
export function buildPullContract(topics: readonly string[]): string {
  const list =
    topics.length > 0
      ? topics.join(", ")
      : "(none configured — pull_conventions is unavailable)";

  return [
    "CONVENTIONS (pull-before-first-write).",
    "Before `create` or the first `edit`/`edit_lines` of a path you have not written this session,",
    "call `pull_conventions` for each matching topic for THAT path only",
    "(the reject message / path→topic map names them) — do NOT pull every topic at session start.",
    "Do not invent file layout, forms, hooks, casts, or JSX patterns from memory — the gate enforces these.",
    "Full guides are NOT in this prompt; they arrive only via `pull_conventions` (or a single matching PUSH after a red).",
    `Topics: ${list}.`,
  ].join(" ");
}
