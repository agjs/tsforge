import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { createRule } from "../../create-rule";
import {
  analyzeThreeImports,
  getThreeImportedName,
  isGpuResourceCtor,
  isThreeNewExpression,
  walkSome,
} from "../utils";

export const RULE_NAME = "require-three-dispose-contract";

export interface IRequireThreeDisposeContractOptions {
  readonly disposeMethodNames?: readonly string[];
}

type RuleOptions = [IRequireThreeDisposeContractOptions];
type MessageIds = "missingDispose";

const DEFAULT_DISPOSE_METHODS: readonly string[] = [
  "dispose",
  "destroy",
  "onModuleDestroy",
];

export const requireThreeDisposeContractRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "A class that constructs Three.js GPU resources (geometry, material, texture, renderer, render target) must declare a dispose/destroy method. Dropping the JS reference does not free VRAM.",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          disposeMethodNames: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
            minItems: 1,
          },
        },
      },
    ],
    messages: {
      missingDispose:
        "Class '{{name}}' constructs Three.js GPU resources but does not declare {{methods}}. Call `dispose()` on geometries, materials, textures, and renderers you own.",
    },
  },
  defaultOptions: [{ disposeMethodNames: [...DEFAULT_DISPOSE_METHODS] }],
  create(context, [options]) {
    const disposeMethods = new Set(
      options.disposeMethodNames ?? DEFAULT_DISPOSE_METHODS
    );
    let imports = analyzeThreeImports(context.sourceCode.ast);

    return {
      Program(program) {
        imports = analyzeThreeImports(program);
      },
      ClassDeclaration(node) {
        if (!imports.hasThreeImport) {
          return;
        }

        if (!classOwnsGpuResource(node, imports)) {
          return;
        }

        if (classDeclaresAnyMethod(node, disposeMethods)) {
          return;
        }

        const className = node.id?.name ?? "<anonymous>";
        const methodList = [...disposeMethods]
          .map((method) => `\`${method}\``)
          .join(", ");

        context.report({
          node: node.id ?? node,
          messageId: "missingDispose",
          data: { name: className, methods: methodList },
        });
      },
    };
  },
});

function classOwnsGpuResource(
  cls: TSESTree.ClassDeclaration,
  imports: ReturnType<typeof analyzeThreeImports>
): boolean {
  for (const member of cls.body.body) {
    if (
      member.type === AST_NODE_TYPES.PropertyDefinition &&
      member.value &&
      isOwnedGpuNew(member.value, imports)
    ) {
      return true;
    }

    if (member.type !== AST_NODE_TYPES.MethodDefinition) {
      continue;
    }

    if (member.kind !== "constructor" || !member.value.body) {
      continue;
    }

    const found = walkSome(member.value.body, (node) => {
      if (node.type !== AST_NODE_TYPES.AssignmentExpression) {
        return false;
      }

      if (
        node.left.type !== AST_NODE_TYPES.MemberExpression ||
        node.left.object.type !== AST_NODE_TYPES.ThisExpression
      ) {
        return false;
      }

      return isOwnedGpuNew(node.right, imports);
    });

    if (found) {
      return true;
    }
  }

  return false;
}

function isOwnedGpuNew(
  node: TSESTree.Node,
  imports: ReturnType<typeof analyzeThreeImports>
): boolean {
  if (!isThreeNewExpression(node, imports)) {
    return false;
  }

  const importedName = getThreeImportedName(node.callee, imports);

  return importedName !== null && isGpuResourceCtor(importedName);
}

function classDeclaresAnyMethod(
  cls: TSESTree.ClassDeclaration,
  methodNames: ReadonlySet<string>
): boolean {
  for (const member of cls.body.body) {
    if (member.type !== AST_NODE_TYPES.MethodDefinition) {
      continue;
    }

    if (member.kind === "constructor") {
      continue;
    }

    const name = methodName(member);

    if (name !== null && methodNames.has(name)) {
      return true;
    }
  }

  return false;
}

function methodName(method: TSESTree.MethodDefinition): string | null {
  if (method.key.type === AST_NODE_TYPES.Identifier) {
    return method.key.name;
  }

  if (
    method.key.type === AST_NODE_TYPES.Literal &&
    typeof method.key.value === "string"
  ) {
    return method.key.value;
  }

  return null;
}
