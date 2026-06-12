import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { isNodeLike } from "../../utils";

const HOOK_NAMES = new Set([
  "useQuery",
  "useInfiniteQuery",
  "useSuspenseQuery",
  "useSuspenseInfiniteQuery",
]);

const PREFIX_UNSAFE_METHODS = new Set([
  "setQueryData",
  "getQueryData",
  "cancelQueries",
  "removeQueries",
  "resetQueries",
  "prefetchQuery",
]);

const METHODS_ALLOWING_PREFIX_FILTER = new Set([
  "cancelQueries",
  "removeQueries",
  "resetQueries",
  "prefetchQuery",
]);

const SKIP_TRAVERSE_KEYS = new Set([
  "parent",
  "tokens",
  "comments",
  "loc",
  "range",
]);

type MessageIds = "useMatcherApi";

function unwrapExpression(node: TSESTree.Expression): TSESTree.Expression {
  let current: TSESTree.Expression = node;

  for (;;) {
    if (current.type === AST_NODE_TYPES.TSAsExpression) {
      current = current.expression;
      continue;
    }

    if (current.type === AST_NODE_TYPES.TSNonNullExpression) {
      current = current.expression;
      continue;
    }

    return current;
  }
}

function getSpreadPrefixText(
  node: TSESTree.Expression,
  getText: (n: TSESTree.Node) => string
): string | null {
  const inner = unwrapExpression(node);

  if (inner.type !== AST_NODE_TYPES.ArrayExpression) {
    return null;
  }

  const { elements } = inner;

  if (elements.length < 2) {
    return null;
  }

  const firstElement = elements[0];

  if (firstElement?.type !== AST_NODE_TYPES.SpreadElement) {
    return null;
  }

  const { argument } = firstElement;

  if (
    argument.type !== AST_NODE_TYPES.Identifier &&
    argument.type !== AST_NODE_TYPES.MemberExpression
  ) {
    return null;
  }

  return getText(argument);
}

function findQueryKeyProperty(
  obj: TSESTree.ObjectExpression
): TSESTree.Property | undefined {
  return obj.properties.find(
    (p): p is TSESTree.Property =>
      p.type === AST_NODE_TYPES.Property &&
      !p.computed &&
      p.key.type === AST_NODE_TYPES.Identifier &&
      p.key.name === "queryKey"
  );
}

function walkAst(
  node: TSESTree.Node,
  visitor: (n: TSESTree.Node) => void
): void {
  visitor(node);

  for (const key of Object.keys(node)) {
    if (SKIP_TRAVERSE_KEYS.has(key)) {
      continue;
    }

    const child = Object.getOwnPropertyDescriptor(node, key)?.value;

    if (child === null || child === undefined) {
      continue;
    }

    if (Array.isArray(child)) {
      for (const c of child) {
        if (isNodeLike(c)) {
          walkAst(c, visitor);
        }
      }
    } else if (isNodeLike(child)) {
      walkAst(child, visitor);
    }
  }
}

function collectExtendedPrefixes(
  program: TSESTree.Program,
  getText: (n: TSESTree.Node) => string
): ReadonlySet<string> {
  const out = new Set<string>();

  walkAst(program, (node) => {
    if (node.type !== AST_NODE_TYPES.CallExpression) {
      return;
    }

    const { callee } = node;

    if (
      callee.type !== AST_NODE_TYPES.Identifier ||
      !HOOK_NAMES.has(callee.name) ||
      node.arguments[0]?.type !== AST_NODE_TYPES.ObjectExpression
    ) {
      return;
    }

    const prop = findQueryKeyProperty(node.arguments[0]);

    if (prop === undefined) {
      return;
    }

    // prop.value might be a Pattern node; only process Expressions
    if (
      prop.value.type === AST_NODE_TYPES.AssignmentPattern ||
      prop.value.type === AST_NODE_TYPES.ArrayPattern ||
      prop.value.type === AST_NODE_TYPES.ObjectPattern ||
      prop.value.type === AST_NODE_TYPES.TSEmptyBodyFunctionExpression
    ) {
      return;
    }

    const prefix = getSpreadPrefixText(prop.value, getText);

    if (prefix !== null) {
      out.add(prefix);
    }
  });

  return out;
}

function queryFilterAllowsPrefixMatch(
  arg: TSESTree.CallExpressionArgument | undefined
): boolean {
  if (arg?.type !== AST_NODE_TYPES.ObjectExpression) {
    return false;
  }

  for (const prop of arg.properties) {
    if (
      prop.type !== AST_NODE_TYPES.Property ||
      prop.computed ||
      prop.key.type !== AST_NODE_TYPES.Identifier
    ) {
      continue;
    }

    if (prop.key.name === "predicate") {
      return true;
    }

    if (
      prop.key.name === "exact" &&
      prop.value.type === AST_NODE_TYPES.Literal &&
      prop.value.value === false
    ) {
      return true;
    }
  }

  return false;
}

function getFirstArgQueryKeyText(
  args: readonly TSESTree.CallExpressionArgument[],
  getText: (n: TSESTree.Node) => string
): string | null {
  const first = args[0];

  if (first === undefined) {
    return null;
  }

  if (first.type === AST_NODE_TYPES.ObjectExpression) {
    const prop = findQueryKeyProperty(first);

    if (prop === undefined) {
      return null;
    }

    // prop.value might be a Pattern node; only process Expressions
    if (
      prop.value.type === AST_NODE_TYPES.AssignmentPattern ||
      prop.value.type === AST_NODE_TYPES.ArrayPattern ||
      prop.value.type === AST_NODE_TYPES.ObjectPattern ||
      prop.value.type === AST_NODE_TYPES.TSEmptyBodyFunctionExpression
    ) {
      return null;
    }

    return getText(unwrapExpression(prop.value));
  }

  if (first.type === AST_NODE_TYPES.SpreadElement) {
    return null;
  }

  return getText(unwrapExpression(first));
}

export const prefixQueryKeyMustUseSetQueriesDataRule = createRule<
  [],
  MessageIds
>({
  name: "prefix-query-key-must-use-set-queries-data",
  meta: {
    type: "problem",
    docs: {
      description:
        "When a hook uses `queryKey: [...prefix, extra]`, do not call `setQueryData(prefix, …)`, `cancelQueries({ queryKey: prefix })`, etc. — those only touch one cache entry. Use `setQueriesData({ queryKey: prefix }, …)` and matcher-style `cancelQueries` / `invalidateQueries` so every variant is covered.",
    },
    schema: [],
    messages: {
      useMatcherApi:
        "Query key spreads `{{prefix}}` with extra segments in this file. Use `setQueriesData` / predicate or `{ queryKey: prefix, exact: false }`-style APIs instead of `{{method}}` with the bare prefix (stale cache for other key variants).",
    },
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;
    const getText = (n: TSESTree.Node) => sourceCode.getText(n);

    return {
      "Program:exit"(program: TSESTree.Program): void {
        const extendedPrefixes = collectExtendedPrefixes(program, getText);

        if (extendedPrefixes.size === 0) {
          return;
        }

        walkAst(program, (node) => {
          if (node.type !== AST_NODE_TYPES.CallExpression) {
            return;
          }

          const { callee } = node;

          if (callee.type !== AST_NODE_TYPES.MemberExpression) {
            return;
          }

          if (callee.property.type !== AST_NODE_TYPES.Identifier) {
            return;
          }

          const method = callee.property.name;

          if (!PREFIX_UNSAFE_METHODS.has(method)) {
            return;
          }

          if (
            METHODS_ALLOWING_PREFIX_FILTER.has(method) &&
            queryFilterAllowsPrefixMatch(node.arguments[0])
          ) {
            return;
          }

          const keyText = getFirstArgQueryKeyText(node.arguments, getText);

          if (keyText === null || !extendedPrefixes.has(keyText)) {
            return;
          }

          context.report({
            node: callee.property,
            messageId: "useMatcherApi",
            data: { prefix: keyText, method },
          });
        });
      },
    };
  },
});
