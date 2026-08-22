import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzeThreeImports,
  childrenObject,
  isObject3DCtor,
  memberPropertyName,
  receiverKey,
  resolveBindingKeys,
} from "../utils";

export const RULE_NAME = "no-direct-children-mutation";

type MessageIds = "childrenPush" | "childrenMutate";

const MUTATING_METHODS = new Set(["push", "splice", "unshift", "pop", "shift"]);

export const noDirectChildrenMutationRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Do not mutate `Object3D.children` as an array. Use `add()` / `remove()` so Three.js hierarchy bookkeeping stays consistent.",
    },
    fixable: "code",
    schema: [],
    messages: {
      childrenPush:
        "Use `{{receiver}}.add(...)` instead of `{{receiver}}.children.push(...)`.",
      childrenMutate:
        "Do not mutate `{{receiver}}.children` directly — use `add()` / `remove()` so parent/child links stay in sync.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzeThreeImports(context.sourceCode.ast);
    const program = context.sourceCode.ast;

    return {
      Program(node) {
        imports = analyzeThreeImports(node);
      },
      CallExpression(node) {
        if (!imports.hasThreeImport) {
          return;
        }

        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        const method = memberPropertyName(node.callee);

        if (method === null || !MUTATING_METHODS.has(method)) {
          return;
        }

        if (node.callee.object.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        const owner = childrenObject(node.callee.object);

        if (!owner) {
          return;
        }

        const ownerKey = receiverKey(owner);

        if (!ownerIsObject3D(ownerKey, node, program, imports)) {
          return;
        }

        const receiver = ownerKey ?? context.sourceCode.getText(owner);

        if (method === "push") {
          const args = node.arguments
            .map((arg) => context.sourceCode.getText(arg))
            .join(", ");

          context.report({
            node,
            messageId: "childrenPush",
            data: { receiver },
            fix: (fixer) => fixer.replaceText(node, `${receiver}.add(${args})`),
          });

          return;
        }

        context.report({
          node,
          messageId: "childrenMutate",
          data: { receiver },
        });
      },
      AssignmentExpression(node) {
        if (!imports.hasThreeImport) {
          return;
        }

        if (node.left.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        const childrenOwner = assignmentChildrenOwner(node.left);

        if (!childrenOwner) {
          return;
        }

        const ownerKey = receiverKey(childrenOwner);

        if (!ownerIsObject3D(ownerKey, node, program, imports)) {
          return;
        }

        context.report({
          node,
          messageId: "childrenMutate",
          data: {
            receiver: ownerKey ?? context.sourceCode.getText(childrenOwner),
          },
        });
      },
    };
  },
});

function ownerIsObject3D(
  ownerKey: string | null,
  node: TSESTree.Node,
  program: TSESTree.Program,
  imports: ReturnType<typeof analyzeThreeImports>
): boolean {
  if (ownerKey === null) {
    return false;
  }

  const keys = resolveBindingKeys(node, program, imports, isObject3DCtor);

  return keys.has(ownerKey);
}

function assignmentChildrenOwner(
  left: TSESTree.MemberExpression
): TSESTree.Expression | null {
  const children = childrenObject(left);

  if (children) {
    return children;
  }

  if (!left.computed) {
    return null;
  }

  if (left.object.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }

  return childrenObject(left.object);
}
