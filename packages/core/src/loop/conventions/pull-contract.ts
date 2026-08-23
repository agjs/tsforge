import { renderPathTopicMap } from "./path-topics";

/**
 * Short system-prompt contract for convention PULL — topic names + the
 * path→topic map, never full guide bodies. Full text arrives via
 * `pull_conventions`, a reject with the guides embedded, or one matching PUSH
 * after a gate red.
 */
export function buildPullContract(
  topics: readonly string[],
  pathMap?: string
): string {
  const list =
    topics.length > 0
      ? topics.join(", ")
      : "(none configured — pull_conventions is unavailable)";
  const map = pathMap ?? renderPathTopicMap(topics);

  return [
    "CONVENTIONS (pull-before-first-write).",
    "Before `create` or the first `edit`/`edit_lines` of a path you have not written this session,",
    "call `pull_conventions` for each topic matching THAT path — do NOT pull every topic at session start.",
    ...(map.length > 0 ? [map] : []),
    "If you miss one, the write is rejected ONCE with the missing guides embedded (they then count as pulled) — read them and retry.",
    "Do not invent file layout, forms, hooks, casts, or JSX patterns from memory — the gate enforces these.",
    "Full guides are NOT in this prompt; they arrive via `pull_conventions`, the reject, or a matching PUSH after a red.",
    `Topics: ${list}.`,
  ].join(" ");
}
