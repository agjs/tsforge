import { AST_NODE_TYPES } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzePhaserImports,
  createHotPathTracker,
  hotPathVisitors,
  isPhysicsColliderCall,
  memberChain,
} from "../utils";

export const RULE_NAME = "no-physics-collider-in-update";

type MessageIds = "colliderInUpdate";

export const noPhysicsColliderInUpdateRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Do not register Arcade overlap/collider handlers inside update/tick/preUpdate. Create them once in setup/create.",
    },
    schema: [],
    messages: {
      colliderInUpdate:
        "Do not call `physics.add.overlap`/`collider` (or `world.addCollider`/`addOverlap`) inside `update`/`tick`. Register colliders once in `create` or scene setup.",
    },
  },
  defaultOptions: [],
  create(context) {
    let imports = analyzePhaserImports(context.sourceCode.ast);
    const hot = createHotPathTracker();

    return {
      Program(program) {
        imports = analyzePhaserImports(program);
      },
      ...hotPathVisitors(hot),
      CallExpression(node) {
        if (!imports.hasPhaserImport || !hot.isInHotPath()) {
          return;
        }

        if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
          return;
        }

        if (!isPhysicsColliderCall(memberChain(node.callee))) {
          return;
        }

        context.report({ node, messageId: "colliderInUpdate" });
      },
    };
  },
});
