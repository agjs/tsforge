import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { toPosixRelative } from "../../utils";

export const RULE_NAME = "no-real-network-in-unit-tests";

export interface INoRealNetworkInUnitTestsOptions {
  readonly testFileSuffixes?: readonly string[];
  readonly integrationMarkers?: readonly string[];
  readonly networkCallees?: readonly string[];
}

type RuleOptions = [INoRealNetworkInUnitTestsOptions];
type MessageIds = "realNetworkInUnitTest";

const DEFAULT_TEST_FILE_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".spec.ts",
  ".spec.tsx",
] as const;

const DEFAULT_INTEGRATION_MARKERS = [
  ".integration.test.",
  ".integration.spec.",
  "/integration/",
] as const;

const DEFAULT_NETWORK_CALLEES = ["fetch"] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    testFileSuffixes: {
      type: "array",
      items: { type: "string" },
    },
    integrationMarkers: {
      type: "array",
      items: { type: "string" },
    },
    networkCallees: {
      type: "array",
      items: { type: "string" },
    },
  },
};

function isUnitTestFile(relPath: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => relPath.endsWith(suffix));
}

function isIntegrationTestFile(
  relPath: string,
  markers: readonly string[]
): boolean {
  return markers.some((marker) => relPath.includes(marker));
}

function getCalleeName(callee: TSESTree.Node): string | null {
  if (callee.type === AST_NODE_TYPES.Identifier) {
    return callee.name;
  }

  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    return callee.property.name;
  }

  return null;
}

function isAxiosCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) {
    return false;
  }

  if (
    callee.object.type !== AST_NODE_TYPES.Identifier ||
    callee.object.name !== "axios"
  ) {
    return false;
  }

  if (callee.property.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  const method = callee.property.name;

  return (
    method === "get" ||
    method === "post" ||
    method === "put" ||
    method === "patch" ||
    method === "delete" ||
    method === "request"
  );
}

export const noRealNetworkInUnitTestsRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Unit tests should not perform real network I/O — mock HTTP clients or move the test to an integration suite.",
      },
      schema: [optionSchema],
      messages: {
        realNetworkInUnitTest:
          "Avoid real network calls in unit tests — mock `{{callee}}` or move this test to an integration file.",
      },
    },
    defaultOptions: [
      {
        testFileSuffixes: [...DEFAULT_TEST_FILE_SUFFIXES],
        integrationMarkers: [...DEFAULT_INTEGRATION_MARKERS],
        networkCallees: [...DEFAULT_NETWORK_CALLEES],
      },
    ],
    create(context, [options]) {
      const testSuffixes =
        options.testFileSuffixes ?? DEFAULT_TEST_FILE_SUFFIXES;
      const integrationMarkers =
        options.integrationMarkers ?? DEFAULT_INTEGRATION_MARKERS;
      const networkCallees = new Set(
        options.networkCallees ?? DEFAULT_NETWORK_CALLEES
      );
      const relPath = toPosixRelative(context.filename, context.cwd);

      if (!isUnitTestFile(relPath, testSuffixes)) {
        return {};
      }

      if (isIntegrationTestFile(relPath, integrationMarkers)) {
        return {};
      }

      return {
        CallExpression(node) {
          const name = getCalleeName(node.callee);

          if (name !== null && networkCallees.has(name)) {
            context.report({
              node,
              messageId: "realNetworkInUnitTest",
              data: { callee: name },
            });

            return;
          }

          if (isAxiosCall(node)) {
            context.report({
              node,
              messageId: "realNetworkInUnitTest",
              data: { callee: "axios" },
            });
          }
        },
      };
    },
  }
);
