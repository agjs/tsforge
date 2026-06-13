import type { TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { isAppRouterFile } from "../utils";

export const RULE_NAME = "no-pages-router-data-fetching-in-app";

type MessageIds = "pagesDataFnInApp";

/** Pages-router data-fetching exports — inert (dead code) under the app router. */
const PAGES_DATA_FNS = new Set<string>([
  "getServerSideProps",
  "getStaticProps",
  "getStaticPaths",
  "getInitialProps",
]);

export const noPagesRouterDataFetchingInAppRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow pages-router data-fetching exports (getServerSideProps, getStaticProps, getStaticPaths, getInitialProps) in app-router files. Next.js ignores them under app/, so they are silent dead code — use async Server Components or route handlers instead.",
    },
    schema: [],
    messages: {
      pagesDataFnInApp:
        "'{{name}}' is a pages-router API and is ignored under app/. Fetch data inside an async Server Component or a route handler instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (!isAppRouterFile(context.filename)) {
      return {};
    }

    function reportName(node: TSESTree.Node, name: string): void {
      context.report({ node, messageId: "pagesDataFnInApp", data: { name } });
    }

    return {
      ExportNamedDeclaration(node) {
        const decl = node.declaration;

        if (
          decl?.type === "FunctionDeclaration" &&
          decl.id !== null &&
          PAGES_DATA_FNS.has(decl.id.name)
        ) {
          reportName(decl.id, decl.id.name);
        } else if (decl?.type === "VariableDeclaration") {
          for (const d of decl.declarations) {
            if (d.id.type === "Identifier" && PAGES_DATA_FNS.has(d.id.name)) {
              reportName(d.id, d.id.name);
            }
          }
        }

        for (const spec of node.specifiers) {
          if (
            spec.exported.type === "Identifier" &&
            PAGES_DATA_FNS.has(spec.exported.name)
          ) {
            reportName(spec, spec.exported.name);
          }
        }
      },
    };
  },
});
