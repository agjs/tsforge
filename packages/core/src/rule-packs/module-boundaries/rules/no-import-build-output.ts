import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { hasDirSegment, isRelativeImport } from "../utils";

export const RULE_NAME = "no-import-build-output";

export interface NoImportBuildOutputOptions {
  readonly outputDirs?: readonly string[];
}

type RuleOptions = [NoImportBuildOutputOptions];
type MessageIds = "buildOutputImported";

const DEFAULT_OUTPUT_DIRS: readonly string[] = [
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    outputDirs: {
      type: "array",
      uniqueItems: true,
      items: { type: "string" },
    },
  },
};

export const noImportBuildOutputRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing from build/output directories within the project. Source must import source, not compiled artifacts, to avoid stale-code drift and broken module boundaries.",
    },
    schema: [optionSchema],
    messages: {
      buildOutputImported:
        "Do not import from build output ('{{source}}'). Import the source module directly so the build graph stays the single source of truth.",
    },
  },
  defaultOptions: [{ outputDirs: [...DEFAULT_OUTPUT_DIRS] }],
  create(context, [options]) {
    const outputDirs = new Set(options.outputDirs ?? DEFAULT_OUTPUT_DIRS);

    return {
      ImportDeclaration(node) {
        const source = node.source.value;

        if (typeof source !== "string" || !isRelativeImport(source)) {
          return;
        }

        if (hasDirSegment(source, outputDirs)) {
          context.report({
            node: node.source,
            messageId: "buildOutputImported",
            data: { source },
          });
        }
      },
    };
  },
});
