import { createRule } from "../../create-rule";
import { isAppRouterFile } from "../utils";

export const RULE_NAME = "no-next-head-in-app";

type MessageIds = "nextHeadInApp";

export const noNextHeadInAppRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing 'next/head' in app-router files. The <Head> component is a no-op under app/ — use the Metadata API (export const metadata / generateMetadata) instead.",
    },
    schema: [],
    messages: {
      nextHeadInApp:
        "'next/head' does nothing in the app router. Use the Metadata API (export const metadata or generateMetadata) instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isAppRouterFile(context.filename)) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value === "next/head") {
          context.report({ node: node.source, messageId: "nextHeadInApp" });
        }
      },
    };
  },
});
