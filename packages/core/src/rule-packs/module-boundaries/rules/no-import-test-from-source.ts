import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { hasDirSegment, isRelativeImport, isTestFileName } from "../utils";

export const RULE_NAME = "no-import-test-from-source";

export interface NoImportTestFromSourceOptions {
  readonly testDirNames?: readonly string[];
}

type RuleOptions = [NoImportTestFromSourceOptions];
type MessageIds = "testImportedFromSource";

const DEFAULT_TEST_DIR_NAMES: readonly string[] = ["__tests__", "__mocks__"];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    testDirNames: {
      type: "array",
      uniqueItems: true,
      items: { type: "string" },
    },
  },
};

export const noImportTestFromSourceRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow production/source files from importing test files. Tests may depend on source, never the reverse — test code must not ship in the production graph.",
    },
    schema: [optionSchema],
    messages: {
      testImportedFromSource:
        "Source files must not import test files ('{{source}}'). Move shared helpers into a non-test module so production code never depends on tests.",
    },
  },
  defaultOptions: [{ testDirNames: [...DEFAULT_TEST_DIR_NAMES] }],
  create(context, [options]) {
    const testDirs = new Set(options.testDirNames ?? DEFAULT_TEST_DIR_NAMES);

    // A test file may freely import other test files; only enforce the
    // boundary when the importing file is itself non-test.
    if (
      isTestFileName(context.filename) ||
      hasDirSegment(context.filename, testDirs)
    ) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        const source = node.source.value;

        if (typeof source !== "string" || !isRelativeImport(source)) {
          return;
        }

        if (isTestFileName(source) || hasDirSegment(source, testDirs)) {
          context.report({
            node: node.source,
            messageId: "testImportedFromSource",
            data: { source },
          });
        }
      },
    };
  },
});
