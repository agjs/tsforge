import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzeThreeImports,
  findEnclosingFunction,
  findEnclosingLoop,
  functionContainsNeedsUpdate,
  isInstancedMeshCtor,
  memberPropertyName,
  receiverKey,
  resolveBindingKeys,
} from "../utils";

export const RULE_NAME = "require-instance-buffer-update";

type MessageIds = "missingNeedsUpdate" | "missingColorNeedsUpdate";

export const requireInstanceBufferUpdateRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "After `InstancedMesh.setMatrixAt()` / `setColorAt()`, set `instanceMatrix.needsUpdate` / `instanceColor.needsUpdate` so GPU buffers refresh.",
    },
    fixable: "code",
    schema: [],
    messages: {
      missingNeedsUpdate:
        "Set `{{receiver}}.instanceMatrix.needsUpdate = true` after `setMatrixAt()`, or instance transforms will not upload.",
      missingColorNeedsUpdate:
        "Set `{{receiver}}.instanceColor.needsUpdate = true` after `setColorAt()`, or instance colors will not upload.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzeThreeImports(context.sourceCode.ast);
    const program = context.sourceCode.ast;
    const reported = new Set<string>();

    return {
      Program(node) {
        imports = analyzeThreeImports(node);
        reported.clear();
      },
      CallExpression(node) {
        if (!imports.hasThreeImport) {
          return;
        }

        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        const method = memberPropertyName(node.callee);

        if (method !== "setMatrixAt" && method !== "setColorAt") {
          return;
        }

        const receiver = receiverKey(node.callee.object);

        if (receiver === null) {
          return;
        }

        const meshes = resolveBindingKeys(
          node,
          program,
          imports,
          isInstancedMeshCtor
        );

        if (!meshes.has(receiver)) {
          return;
        }

        const scope = findEnclosingFunction(node) ?? program;
        const bufferName =
          method === "setMatrixAt" ? "instanceMatrix" : "instanceColor";
        const reportKey = `${receiver}:${bufferName}:${scope.range[0]}`;

        if (reported.has(reportKey)) {
          return;
        }

        if (functionContainsNeedsUpdate(scope, receiver, bufferName)) {
          return;
        }

        reported.add(reportKey);

        const messageId =
          method === "setMatrixAt"
            ? "missingNeedsUpdate"
            : "missingColorNeedsUpdate";
        const insertAt = findEnclosingLoop(node) ?? enclosingStatement(node);

        context.report({
          node,
          messageId,
          data: { receiver },
          fix:
            insertAt === null
              ? undefined
              : (fixer) =>
                  fixer.insertTextAfter(
                    insertAt,
                    `\n${receiver}.${bufferName}.needsUpdate = true;`
                  ),
        });
      },
    };
  },
});

function enclosingStatement(node: TSESTree.Node): TSESTree.Node | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === AST_NODE_TYPES.ExpressionStatement) {
      return current;
    }

    if (
      current.type === AST_NODE_TYPES.FunctionDeclaration ||
      current.type === AST_NODE_TYPES.FunctionExpression ||
      current.type === AST_NODE_TYPES.ArrowFunctionExpression
    ) {
      return null;
    }
  }

  return null;
}
