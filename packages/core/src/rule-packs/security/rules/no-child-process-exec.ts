import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-child-process-exec";

type MessageIds = "noExec";

const EXEC_METHODS = new Set(["exec", "execSync"]);

function isChildProcessExecCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) {
    return false;
  }

  if (callee.property.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  if (!EXEC_METHODS.has(callee.property.name)) {
    return false;
  }

  const object = callee.object;

  if (
    object.type === AST_NODE_TYPES.Identifier &&
    (object.name === "child_process" || object.name === "cp")
  ) {
    return true;
  }

  if (
    object.type === AST_NODE_TYPES.MemberExpression &&
    !object.computed &&
    object.object.type === AST_NODE_TYPES.Identifier &&
    object.object.name === "child_process" &&
    object.property.type === AST_NODE_TYPES.Identifier
  ) {
    return EXEC_METHODS.has(object.property.name);
  }

  return false;
}

export const noChildProcessExecRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow child_process.exec/execSync — they run commands in a shell. Use execFile or spawn without shell instead.",
    },
    schema: [],
    messages: {
      noExec:
        "Do not use `child_process.exec` or `execSync` — use `execFile`/`spawn` without a shell to avoid command injection.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (isChildProcessExecCall(node)) {
          context.report({ node, messageId: "noExec" });
        }
      },
    };
  },
});
