import { createRule } from "../../create-rule";
import {
  calleeName,
  hasDirective,
  isAppRouterFile,
  isRouteEntryFile,
} from "../utils";

export const RULE_NAME = "client-hooks-require-use-client";

type MessageIds = "missingUseClient";

/** Hooks that only work in Client Components — calling them in a Server
 *  Component throws at runtime. */
const CLIENT_HOOKS = new Set<string>([
  "useState",
  "useEffect",
  "useLayoutEffect",
  "useReducer",
  "useImperativeHandle",
  "useSyncExternalStore",
  "useRouter",
  "usePathname",
  "useSearchParams",
  "useParams",
]);

export const clientHooksRequireUseClientRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the 'use client' directive in app-router page/layout/template files that call client-only hooks. Server Components cannot use state/effect/navigation hooks — doing so crashes at runtime.",
    },
    schema: [],
    messages: {
      missingUseClient:
        "'{{hook}}' is a client-only hook but this Server Component has no 'use client' directive. Add 'use client' at the top of the file or move the interactivity into a Client Component.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (
      !isAppRouterFile(context.filename) ||
      !isRouteEntryFile(context.filename)
    ) {
      return {};
    }

    let clientComponent = false;

    return {
      Program(node) {
        clientComponent = hasDirective(node, "use client");
      },
      CallExpression(node) {
        if (clientComponent) {
          return;
        }

        const name = calleeName(node.callee);

        if (name !== null && CLIENT_HOOKS.has(name)) {
          context.report({
            node,
            messageId: "missingUseClient",
            data: { hook: name },
          });
        }
      },
    };
  },
});
