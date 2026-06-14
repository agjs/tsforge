import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-user-input-in-system-prompt";

type MessageIds = "dynamicSystemPrompt";

/** A value built by interpolation/concatenation rather than a constant string —
 *  the shape that splices request data into the system prompt (injection). A
 *  plain string, identifier, or constant template (no `${}`) is fine. */
function isDynamicString(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.TemplateLiteral) {
    return node.expressions.length > 0;
  }

  return node.type === AST_NODE_TYPES.BinaryExpression && node.operator === "+";
}

/** Find a non-computed string-keyed property on an object literal. */
function findProperty(
  obj: TSESTree.ObjectExpression,
  name: string
): TSESTree.Property | null {
  for (const p of obj.properties) {
    if (
      p.type === AST_NODE_TYPES.Property &&
      !p.computed &&
      p.key.type === AST_NODE_TYPES.Identifier &&
      p.key.name === name
    ) {
      return p;
    }
  }

  return null;
}

/** True when the object is a chat message with `role: "system"`. */
function isSystemMessage(obj: TSESTree.ObjectExpression): boolean {
  const role = findProperty(obj, "role");

  return (
    role !== null &&
    role.value.type === AST_NODE_TYPES.Literal &&
    role.value.value === "system"
  );
}

export const noUserInputInSystemPromptRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Warn when a system prompt is built by string interpolation/concatenation — splicing request data into the system role enables prompt injection. Keep the system prompt constant; pass user input as a user message.",
    },
    schema: [],
    messages: {
      dynamicSystemPrompt:
        "System prompt is built dynamically — do not interpolate request/user data into the system role (prompt injection). Keep it a constant and pass user input as a `user` message.",
    },
  },
  defaultOptions: [],
  create(context) {
    const reportIfDynamic = (value: TSESTree.Node | null): void => {
      if (value !== null && isDynamicString(value)) {
        context.report({ node: value, messageId: "dynamicSystemPrompt" });
      }
    };

    return {
      // Vercel AI SDK: `{ system: `...${x}...` }`
      "Property[key.name='system']"(node: TSESTree.Property) {
        if (!node.computed) {
          reportIfDynamic(node.value);
        }
      },
      // Chat messages: `{ role: "system", content: `...${x}...` }`
      ObjectExpression(node: TSESTree.ObjectExpression) {
        if (!isSystemMessage(node)) {
          return;
        }

        const content = findProperty(node, "content");

        reportIfDynamic(content === null ? null : content.value);
      },
    };
  },
});
