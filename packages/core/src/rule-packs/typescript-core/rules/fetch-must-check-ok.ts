import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";

export const RULE_NAME = "fetch-must-check-ok";

type MessageIds = "missingOkCheck";

/** Reading either one counts as checking the response: `res.ok` is the idiom,
 *  but `res.status === 204` is an equally deliberate check. */
const OK_PROPS = new Set(["ok", "status"]);

/** A non-computed `<object>.<prop>` read, e.g. `res.json` or `res.ok`. */
function propReadOn(
  node: TSESTree.Node,
  objectName: string,
  props: ReadonlySet<string> | string
): node is TSESTree.MemberExpression {
  if (node.type !== AST_NODE_TYPES.MemberExpression || node.computed) {
    return false;
  }

  if (
    node.object.type !== AST_NODE_TYPES.Identifier ||
    node.object.name !== objectName ||
    node.property.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }

  const name = node.property.name;

  return typeof props === "string" ? name === props : props.has(name);
}

/** The `<res>.json` read inside `root`, or null when the response is never
 *  parsed — nothing to warn about if the body is only ever discarded. */
function findJsonRead(
  root: TSESTree.Node,
  name: string
): TSESTree.MemberExpression | null {
  let found: TSESTree.MemberExpression | null = null;

  walkSome(root, (node) => {
    if (found === null && propReadOn(node, name, "json")) {
      found = node;
    }

    return false;
  });

  return found;
}

function hasOkCheck(root: TSESTree.Node, name: string): boolean {
  return walkSome(root, (node) => propReadOn(node, name, OK_PROPS));
}

/** Where to look for the check: the nearest enclosing block or function body,
 *  so a later `if (res.ok)` in the same function counts however it is written —
 *  early return, guard clause, ternary. */
function scopeOf(node: TSESTree.Node): TSESTree.Node {
  let current: TSESTree.Node | undefined = node.parent;

  while (current !== undefined) {
    if (
      current.type === AST_NODE_TYPES.BlockStatement ||
      current.type === AST_NODE_TYPES.Program
    ) {
      return current;
    }

    current = current.parent;
  }

  return node;
}

/** Strip the `await` wrapper so `(await fetch(url)).json()` and
 *  `fetch(url).json()` reach the same branch. */
function skipAwait(node: TSESTree.Node | undefined): TSESTree.Node | undefined {
  return node?.type === AST_NODE_TYPES.AwaitExpression ? node.parent : node;
}

/** The response identifier a `.then(res => ...)` callback binds, or null. */
function thenCallbackParam(node: TSESTree.Node): {
  name: string;
  body: TSESTree.Node;
} | null {
  if (
    node.type !== AST_NODE_TYPES.MemberExpression ||
    node.computed ||
    node.property.type !== AST_NODE_TYPES.Identifier ||
    node.property.name !== "then" ||
    node.parent.type !== AST_NODE_TYPES.CallExpression
  ) {
    return null;
  }

  const callback = node.parent.arguments[0];

  if (
    callback === undefined ||
    (callback.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
      callback.type !== AST_NODE_TYPES.FunctionExpression)
  ) {
    return null;
  }

  const param = callback.params[0];

  return param?.type === AST_NODE_TYPES.Identifier
    ? { name: param.name, body: callback.body }
    : null;
}

export const fetchMustCheckOkRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "HTTP fetch responses must check `.ok` or status before calling `.json()`.",
    },
    schema: [],
    messages: {
      missingOkCheck:
        "Check `response.ok` (or status) before calling `.json()` on a fetch response.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        const callee = node.callee;

        if (
          callee.type !== AST_NODE_TYPES.Identifier ||
          callee.name !== "fetch"
        ) {
          return;
        }

        const parent = skipAwait(node.parent);

        if (parent === undefined) {
          return;
        }

        // `fetch(url).json()` / `(await fetch(url)).json()` — the response is
        // never bound, so no check can exist anywhere.
        if (
          parent.type === AST_NODE_TYPES.MemberExpression &&
          !parent.computed &&
          parent.property.type === AST_NODE_TYPES.Identifier &&
          parent.property.name === "json"
        ) {
          context.report({ node: parent, messageId: "missingOkCheck" });

          return;
        }

        // `fetch(url).then(res => res.json())` — the callback parameter is the
        // response, and the callback body is the whole scope it lives in.
        const callback = thenCallbackParam(parent);

        if (callback !== null) {
          const read = findJsonRead(callback.body, callback.name);

          if (read !== null && !hasOkCheck(callback.body, callback.name)) {
            context.report({ node: read, messageId: "missingOkCheck" });
          }

          return;
        }

        // `const res = await fetch(url); ... res.json()` — the common shape.
        // Look for the check anywhere in the enclosing block, since it is
        // normally a guard clause on the line after.
        if (
          parent.type !== AST_NODE_TYPES.VariableDeclarator ||
          parent.id.type !== AST_NODE_TYPES.Identifier
        ) {
          return;
        }

        const name = parent.id.name;
        const scope = scopeOf(parent);
        const read = findJsonRead(scope, name);

        if (read !== null && !hasOkCheck(scope, name)) {
          context.report({ node: read, messageId: "missingOkCheck" });
        }
      },
    };
  },
});
