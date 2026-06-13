import type { TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { isTestFile } from "../../react-component-architecture/utils";
import { nodeContainsMemberCall } from "../utils/fastifyChain";

export const RULE_NAME = "test-inject-must-close-app";

type MessageIds = "missingAppClose";

export const testInjectMustCloseAppRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Test files using fastify.inject must register teardown that calls app.close() to drain connections.",
    },
    schema: [],
    messages: {
      missingAppClose:
        "Tests using `.inject(...)` must call `app.close()` in an `after`/`t.after` hook to drain connection pools.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename;

    if (!isTestFile(filename)) {
      return {};
    }

    return {
      "Program:exit"(program: TSESTree.Program) {
        const usesInject = nodeContainsMemberCall(program, "inject");
        const closesApp = nodeContainsMemberCall(program, "close");

        if (usesInject && !closesApp) {
          context.report({ node: program, messageId: "missingAppClose" });
        }
      },
    };
  },
});
