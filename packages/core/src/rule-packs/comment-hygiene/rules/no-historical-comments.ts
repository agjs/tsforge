import type { TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-historical-comments";

type MessageIds = "historicalComment";

/*
 * Patterns that frame code relative to what it USED TO be or to a past
 * incident, instead of describing the current invariant. Each entry is
 * deliberately narrow — bare "now" / "legacy" / "previously" appear in
 * legitimate technical prose, so the rule only matches the specific
 * historical-narration constructions that have to come out.
 */
const HISTORICAL_PATTERNS: readonly RegExp[] = [
  /\bcodex\s+flagged\b/iu,
  /\bbefore\s+the\s+fix\b/iu,
  /\bafter\s+the\s+fix\b/iu,
  /\bbefore\s+the\s+refactor\b/iu,
  /\bafter\s+the\s+refactor\b/iu,
  /\bthe\s+[a-z][\w-]*\s+refactor\b/iu,
  /\bwe\s+used\s+to\b/iu,
  /\bthis\s+used\s+to\b/iu,
  /\bused\s+to\s+be\b/iu,
  /\bno\s+longer\b/iu,
  /\bkept\s+for\s+(?:backwards|backward|legacy|compat)\b/iu,
  /\b(?:was|were)\s+a\s+(?:footgun|bug)\b/iu,
  /\bhistorical(?:ly)?\b/iu,
  /\balpine[-\s]?era\b/iu,
];

function commentText(comment: TSESTree.Comment): string {
  if (comment.type === "Line") {
    return comment.value.trim();
  }

  return comment.value
    .split("\n")
    .map((line) => line.replace(/^\s*\*?/u, ""))
    .join(" ")
    .trim();
}

function looksLikeJsDoc(comment: TSESTree.Comment): boolean {
  return comment.type === "Block" && comment.value.startsWith("*");
}

export const noHistoricalCommentsRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow comments that frame code relative to what it used to do or to a past incident ('Codex flagged X', 'before the fix', 'after the refactor', 'we used to', 'no longer'). Source comments must describe the current invariant; history belongs in the commit message or PR description, where it doesn't rot when the code changes again.",
    },
    schema: [],
    messages: {
      historicalComment:
        "Historical narration ({{snippet}}). Source comments describe the current invariant, not what the code used to do — move the history to the commit message or delete the comment.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Program() {
        const comments = context.sourceCode.getAllComments();

        for (const comment of comments) {
          if (looksLikeJsDoc(comment)) {
            continue;
          }

          const text = commentText(comment);

          if (text === "") {
            continue;
          }

          for (const pattern of HISTORICAL_PATTERNS) {
            const match = pattern.exec(text);

            if (match !== null) {
              const matchedPhrase = match[0];
              const snippet =
                matchedPhrase.length > 40
                  ? `${matchedPhrase.slice(0, 40)}…`
                  : matchedPhrase;

              context.report({
                loc: comment.loc,
                messageId: "historicalComment",
                data: { snippet },
              });
              break;
            }
          }
        }
      },
    };
  },
});
