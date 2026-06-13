import type { TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { hasDirective, isErrorBoundaryFile } from "../utils";

export const RULE_NAME = "error-boundary-require-use-client";

type MessageIds = "missingUseClient";

export const errorBoundaryRequireUseClientRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Require 'use client' in app-router error.tsx and global-error.tsx — Next.js error boundaries must be Client Components.",
    },
    schema: [],
    messages: {
      missingUseClient:
        "Error boundaries under app/ must start with `'use client'` — Next.js requires Client Components for error.tsx and global-error.tsx.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isErrorBoundaryFile(context.filename)) {
      return {};
    }

    return {
      Program(node: TSESTree.Program) {
        if (!hasDirective(node, "use client")) {
          context.report({ node, messageId: "missingUseClient" });
        }
      },
    };
  },
});
