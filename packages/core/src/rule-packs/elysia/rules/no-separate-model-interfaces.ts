import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { getCalleeName } from "../utils/elysiaChain";

export const RULE_NAME = "no-separate-model-interfaces";

export interface NoSeparateModelInterfacesOptions {
  readonly schemaSuffixes?: readonly string[];
  readonly schemaFactoryNames?: readonly string[];
}

type RuleOptions = [NoSeparateModelInterfacesOptions];
type MessageIds = "noSeparateModelInterface";

const DEFAULT_SCHEMA_SUFFIXES = [
  "Schema",
  "Model",
  "Dto",
  "DTO",
  "Request",
  "Response",
] as const;

const DEFAULT_SCHEMA_FACTORY_NAMES = [
  "t.Object",
  "Elysia.t.Object",
  "Type.Object",
  "z.object",
  "v.object",
] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaSuffixes: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    schemaFactoryNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
  },
};

export const noSeparateModelInterfacesRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow TypeScript interfaces that duplicate the shape of a runtime schema with a matching name. Use `typeof Schema.static` (or your project's equivalent) instead.",
    },
    schema: [optionSchema],
    messages: {
      noSeparateModelInterface:
        "Interface '{{interface}}' duplicates schema '{{schema}}'. Replace with `type {{interface}} = typeof {{schema}}.static` (or equivalent) to keep the type and the runtime validator from drifting.",
    },
  },
  defaultOptions: [
    {
      schemaSuffixes: [...DEFAULT_SCHEMA_SUFFIXES],
      schemaFactoryNames: [...DEFAULT_SCHEMA_FACTORY_NAMES],
    },
  ],
  create(context, [options]) {
    const suffixes = options.schemaSuffixes ?? DEFAULT_SCHEMA_SUFFIXES;
    const factoryNames = new Set(
      options.schemaFactoryNames ?? DEFAULT_SCHEMA_FACTORY_NAMES
    );

    const schemaByBase = new Map<string, string>();
    const interfaces: TSESTree.TSInterfaceDeclaration[] = [];

    return {
      VariableDeclarator(node) {
        if (node.id.type !== AST_NODE_TYPES.Identifier) {
          return;
        }

        if (node.init?.type !== AST_NODE_TYPES.CallExpression) {
          return;
        }

        const calleeName = getCalleeName(node.init);

        if (!calleeName || !factoryNames.has(calleeName)) {
          return;
        }

        const base = stripSuffix(node.id.name, suffixes);

        if (base.length > 0) {
          schemaByBase.set(base, node.id.name);
        }
      },
      TSInterfaceDeclaration(node) {
        interfaces.push(node);
      },
      "Program:exit"() {
        for (const iface of interfaces) {
          const base = stripSuffix(iface.id.name, suffixes);

          if (base.length === 0) {
            continue;
          }

          const schemaName = schemaByBase.get(base);

          if (!schemaName) {
            continue;
          }

          context.report({
            node: iface.id,
            messageId: "noSeparateModelInterface",
            data: {
              interface: iface.id.name,
              schema: schemaName,
            },
          });
        }
      },
    };
  },
});

function stripSuffix(name: string, suffixes: readonly string[]): string {
  for (const suffix of suffixes) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return name.slice(0, -suffix.length);
    }
  }

  return name;
}
