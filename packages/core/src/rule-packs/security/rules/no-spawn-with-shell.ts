import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-spawn-with-shell";

type MessageIds = "spawnWithShell";

function isExpression(node: TSESTree.Node): node is TSESTree.Expression {
  return node.type !== AST_NODE_TYPES.SpreadElement;
}

function isShellTrue(node: TSESTree.Expression): boolean {
  if (node.type === AST_NODE_TYPES.Literal && node.value === true) {
    return true;
  }

  return false;
}

function optionsEnableShell(optionsArg: TSESTree.Expression): boolean {
  if (optionsArg.type !== AST_NODE_TYPES.ObjectExpression) {
    return false;
  }

  for (const prop of optionsArg.properties) {
    if (prop.type !== AST_NODE_TYPES.Property || prop.computed) {
      continue;
    }

    const key = prop.key;

    if (
      key.type === AST_NODE_TYPES.Identifier &&
      key.name === "shell" &&
      isExpression(prop.value) &&
      isShellTrue(prop.value)
    ) {
      return true;
    }

    if (
      key.type === AST_NODE_TYPES.Literal &&
      key.value === "shell" &&
      isExpression(prop.value) &&
      isShellTrue(prop.value)
    ) {
      return true;
    }
  }

  return false;
}

function isSpawnCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (callee.type === AST_NODE_TYPES.Identifier) {
    return callee.name === "spawn" || callee.name === "spawnSync";
  }

  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    (callee.property.name === "spawn" || callee.property.name === "spawnSync")
  ) {
    return true;
  }

  return false;
}

export const noSpawnWithShellRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow child_process.spawn/spawnSync with shell: true — shell execution enables command injection.",
    },
    schema: [],
    messages: {
      spawnWithShell:
        "Do not pass `{ shell: true }` to `spawn`/`spawnSync` — execute the binary directly with argument arrays instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isSpawnCall(node)) {
          return;
        }

        for (const arg of node.arguments) {
          if (isExpression(arg) && optionsEnableShell(arg)) {
            context.report({ node, messageId: "spawnWithShell" });

            return;
          }
        }
      },
    };
  },
});
