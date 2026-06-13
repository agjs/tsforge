import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import { walkSome } from "../../utils";

export const RULE_NAME = "no-derived-state-in-effect";

type MessageIds = "derivedStateInEffect";

function isUseStateSetterName(name: string): boolean {
  return /^set[A-Z]/.test(name);
}

function collectUseStateSetters(
  node: TSESTree.FunctionDeclaration | TSESTree.ArrowFunctionExpression
): Set<string> {
  const setters = new Set<string>();
  const body =
    node.type === AST_NODE_TYPES.ArrowFunctionExpression
      ? node.body.type === AST_NODE_TYPES.BlockStatement
        ? node.body
        : null
      : node.body;

  if (body === null) {
    return setters;
  }

  walkSome(body, (current) => {
    if (current.type !== AST_NODE_TYPES.VariableDeclarator) {
      return false;
    }

    if (
      current.id.type !== AST_NODE_TYPES.ArrayPattern ||
      current.init?.type !== AST_NODE_TYPES.CallExpression
    ) {
      return false;
    }

    const initCallee = current.init.callee;

    if (
      initCallee.type !== AST_NODE_TYPES.Identifier ||
      initCallee.name !== "useState"
    ) {
      return false;
    }

    const setter = current.id.elements[1];

    if (setter?.type === AST_NODE_TYPES.Identifier) {
      setters.add(setter.name);
    }

    return false;
  });

  return setters;
}

function isInsideNode(node: TSESTree.Node, ancestor: TSESTree.Node): boolean {
  let current: TSESTree.Node | null | undefined = node;

  while (current !== undefined && current !== null) {
    if (current === ancestor) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function setterCalledOutsideEffect(
  root: TSESTree.Node,
  setterName: string,
  effectNode: TSESTree.CallExpression
): boolean {
  return walkSome(root, (current) => {
    if (current.type !== AST_NODE_TYPES.CallExpression) {
      return false;
    }

    if (isInsideNode(current, effectNode)) {
      return false;
    }

    const callee = current.callee;

    return (
      callee.type === AST_NODE_TYPES.Identifier && callee.name === setterName
    );
  });
}

function effectCallsSetter(
  effectFn: TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression,
  setterName: string
): boolean {
  return walkSome(effectFn.body, (current) => {
    if (current.type !== AST_NODE_TYPES.CallExpression) {
      return false;
    }

    const callee = current.callee;

    return (
      callee.type === AST_NODE_TYPES.Identifier && callee.name === setterName
    );
  });
}

export const noDerivedStateInEffectRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow setting local state inside useEffect when the value can be derived during render (or memoized with useMemo).",
    },
    schema: [],
    messages: {
      derivedStateInEffect:
        "Do not call `{{setter}}` only inside `useEffect` — compute derived values during render or wrap expensive work in `useMemo`.",
    },
  },
  defaultOptions: [],
  create(context) {
    function checkFunction(
      node: TSESTree.FunctionDeclaration | TSESTree.ArrowFunctionExpression
    ): void {
      const setters = collectUseStateSetters(node);

      if (setters.size === 0) {
        return;
      }

      const body =
        node.type === AST_NODE_TYPES.ArrowFunctionExpression
          ? node.body.type === AST_NODE_TYPES.BlockStatement
            ? node.body
            : null
          : node.body;

      if (body === null) {
        return;
      }

      walkSome(body, (current) => {
        if (current.type !== AST_NODE_TYPES.CallExpression) {
          return false;
        }

        const callee = current.callee;

        if (
          callee.type !== AST_NODE_TYPES.Identifier ||
          callee.name !== "useEffect"
        ) {
          return false;
        }

        const effectFn = current.arguments[0];

        if (
          effectFn?.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
          effectFn?.type !== AST_NODE_TYPES.FunctionExpression
        ) {
          return false;
        }

        for (const setterName of setters) {
          if (!isUseStateSetterName(setterName)) {
            continue;
          }

          if (
            effectCallsSetter(effectFn, setterName) &&
            !setterCalledOutsideEffect(body, setterName, current)
          ) {
            context.report({
              node: current,
              messageId: "derivedStateInEffect",
              data: { setter: setterName },
            });
          }
        }

        return false;
      });
    }

    return {
      FunctionDeclaration: checkFunction,
      ArrowFunctionExpression(node: TSESTree.ArrowFunctionExpression) {
        if (node.parent?.type === AST_NODE_TYPES.VariableDeclarator) {
          checkFunction(node);
        }
      },
    };
  },
});
