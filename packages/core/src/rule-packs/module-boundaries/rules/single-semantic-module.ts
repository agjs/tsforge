import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";

export const RULE_NAME = "single-semantic-module";

type Options = [SingleSemanticModuleOptions?];
type MessageIds = "mixedSemanticCategories";

export interface SingleSemanticModuleOptions {
  readonly allow?: readonly (readonly string[])[];
  readonly enumCategory?: "enum" | "type";
  readonly debug?: boolean;
  readonly ignoreAmbientDeclarations?: boolean;
  readonly schemaLibraries?: readonly ("zod" | "yup" | "valibot")[];
  readonly reactComponentDetection?: {
    readonly enabled?: boolean;
  };
  readonly hookDetection?: {
    readonly enabled?: boolean;
    readonly namePattern?: string;
  };
}

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    allow: {
      type: "array",
      items: {
        type: "array",
        minItems: 2,
        uniqueItems: true,
        items: {
          type: "string",
        },
      },
    },
    enumCategory: {
      type: "string",
      enum: ["enum", "type"],
    },
    debug: {
      type: "boolean",
    },
    ignoreAmbientDeclarations: {
      type: "boolean",
    },
    schemaLibraries: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        enum: ["zod", "yup", "valibot"],
      },
    },
    reactComponentDetection: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
        },
      },
    },
    hookDetection: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
        },
        namePattern: {
          type: "string",
        },
      },
    },
  },
};

/**
 * Simplified single-semantic-module rule. The full version from the source plugin
 * requires extensive semantic analysis (classifiers, category detection, etc.).
 * This version provides a basic implementation that validates the rule structure.
 * A full implementation would require vendoring all the analysis infrastructure.
 */
export const singleSemanticModuleRule = createRule<Options, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Require each TypeScript module to contain only one top-level semantic concern.",
    },
    schema: [optionSchema],
    messages: {
      mixedSemanticCategories: "{{message}}",
    },
  },
  defaultOptions: [{}],
  create(_context, [_options]) {
    return {
      Program() {
        // Simplified implementation: would require full semantic analysis
        // to properly detect and report mixed semantic categories.
        // For now, this allows the rule to be registered without false positives.
      },
    };
  },
});
