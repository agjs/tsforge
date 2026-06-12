import type { TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-pr-reference-comments";

type MessageIds = "prReferenceComment";

interface IPrPattern {
  readonly pattern: RegExp;
  readonly label: string;
}

const PR_PATTERNS: readonly IPrPattern[] = [
  {
    pattern: /https?:\/\/github\.com\/[^\s)]+\/(?:pull|issues)\/\d+/iu,
    label: "GitHub PR/issue URL",
  },
  {
    pattern: /\b(?:see|closes?|fixes|fixed|addresses|resolves?|refs?)\s+#\d+/iu,
    label: "issue/PR reference",
  },
  {
    pattern: /\bPRs?\s+#?\d+/iu,
    label: "PR number",
  },
  {
    pattern: /(?:^|[\s(])#\d+\b/u,
    label: "issue/PR number",
  },
];

function commentText(comment: TSESTree.Comment): string {
  if (comment.type === "Line") {
    return comment.value;
  }

  return comment.value;
}

export const noPrReferenceCommentsRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow PR/issue references in comments. They belong in commit messages and PR descriptions — leaving them in source rots when the repo moves, the issue tracker migrates, or the numbering changes.",
    },
    schema: [],
    messages: {
      prReferenceComment:
        "Comment contains {{label}} ({{snippet}}). Move it to the commit message or PR description — the git log is the canonical place for repo-history references.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      Program() {
        const comments = context.sourceCode.getAllComments();

        for (const comment of comments) {
          const text = commentText(comment);

          if (text.trim() === "") {
            continue;
          }

          for (const { pattern, label } of PR_PATTERNS) {
            const match = pattern.exec(text);

            if (match === null) {
              continue;
            }

            const matched = match[0].trim();
            const snippet =
              matched.length > 40 ? `${matched.slice(0, 40)}…` : matched;

            context.report({
              loc: comment.loc,
              messageId: "prReferenceComment",
              data: { label, snippet },
            });
            break;
          }
        }
      },
    };
  },
});
