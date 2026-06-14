import { type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { isStoryFile, isTestFile } from "../utils";

export const RULE_NAME = "no-loading-text-use-skeleton";

type RuleOptions = [];
type MessageIds = "useSkeleton";

/** A loading PLACEHOLDER text node: "Loading", "Loading…", "Loading...",
 *  "loading data" — the spinner-era text models reach for. Matched
 *  case-insensitively against the trimmed text; an ordinary sentence that merely
 *  CONTAINS the word "loading" mid-string is NOT flagged (anchored at start). */
const LOADING_TEXT = /^loading\b[\s.…!]*$/iu;

function isLoadingText(raw: string): boolean {
  return LOADING_TEXT.test(raw.trim());
}

export const noLoadingTextUseSkeletonRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description:
          "Loading states must render a <Skeleton/>, not loading text or a spinner",
      },
      schema: [],
      messages: {
        useSkeleton:
          "Render a <Skeleton/> shaped like the content, not loading text. Every isLoading/isPending branch shows skeletons — never a spinner or 'Loading…' text.",
      },
    },
    defaultOptions: [],
    create(context) {
      const filename = context.filename;

      if (isStoryFile(filename) || isTestFile(filename)) {
        return {};
      }

      return {
        JSXText(node: TSESTree.JSXText) {
          if (isLoadingText(node.value)) {
            context.report({ node, messageId: "useSkeleton" });
          }
        },
        "JSXElement > Literal"(node: TSESTree.Literal) {
          if (typeof node.value === "string" && isLoadingText(node.value)) {
            context.report({ node, messageId: "useSkeleton" });
          }
        },
        "JSXExpressionContainer > Literal"(node: TSESTree.Literal) {
          if (typeof node.value === "string" && isLoadingText(node.value)) {
            context.report({ node, messageId: "useSkeleton" });
          }
        },
      };
    },
  }
);
