import type { IProvider } from "./inference";

/**
 * Classify the user's FIRST message so tsforge can route to an opinionated
 * approach instead of improvising every time. `web`/`node` are scaffold (build-
 * new) intents; `existing` modifies the current project; `chat` is a question.
 * This is the lever for quality: a "build me a todo app" gets a structured,
 * tooled scaffold by construction rather than a single-file blob.
 */
export type TaskKind = "web" | "node" | "existing" | "chat";

const CLASSIFY_SYSTEM = [
  "Classify the user's request into EXACTLY one word:",
  "  web      — build a browser app or UI (DOM, HTML, a web page/app)",
  "  node     — build a CLI, library, or script (no browser UI)",
  "  existing — modify, fix, debug, or extend the project already in this directory",
  "  chat     — a question or discussion; not a request to build/change code",
  "Reply with ONLY that one lowercase word, nothing else.",
].join("\n");

export async function classifyIntent(
  provider: IProvider,
  message: string
): Promise<TaskKind> {
  const res = await provider.complete(
    [
      { role: "system", content: CLASSIFY_SYSTEM },
      { role: "user", content: message },
    ],
    { temperature: 0, enableThinking: false }
  );

  const word = res.content.toLowerCase();

  if (word.includes("web")) {
    return "web";
  }

  if (word.includes("existing")) {
    return "existing";
  }

  if (word.includes("node")) {
    return "node";
  }

  return "chat";
}
