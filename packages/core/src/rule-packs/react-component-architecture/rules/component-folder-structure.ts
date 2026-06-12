import { existsSync } from "fs";
import { dirname, join } from "path";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { getComponentName, isComponentFile, isInShadcnUi } from "../utils";

export const RULE_NAME = "component-folder-structure";

export interface ComponentFolderStructureOptions {
  readonly requiredSiblings?: readonly string[];
  readonly ignorePaths?: readonly string[];
}

type RuleOptions = [ComponentFolderStructureOptions];
type MessageIds = "missingSiblings";

const DEFAULT_SIBLINGS = [
  "<Name>.hooks.ts",
  "<Name>.types.ts",
  "<Name>.stories.tsx",
  "<Name>.test.ts",
  "index.ts",
];

const DEFAULT_IGNORE_PATHS = [
  "src/components/ui/",
  "tests/",
  "e2e/",
  ".storybook/",
  "node_modules",
];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    requiredSiblings: {
      type: "array",
      items: { type: "string" },
    },
    ignorePaths: {
      type: "array",
      items: { type: "string" },
    },
  },
};

export const componentFolderStructureRule = createRule<RuleOptions, MessageIds>(
  {
    name: RULE_NAME,
    meta: {
      type: "problem",
      docs: {
        description:
          "Enforce required sibling files in component folders (hooks, types, stories, test, index)",
      },
      schema: [optionSchema],
      messages: {
        missingSiblings:
          "Component '{{name}}' is missing required siblings: {{missing}}",
      },
    },
    defaultOptions: [
      {
        requiredSiblings: DEFAULT_SIBLINGS,
        ignorePaths: DEFAULT_IGNORE_PATHS,
      },
    ],
    create(context, [options]) {
      const filename = context.filename;

      if (!isComponentFile(filename)) {
        return {};
      }

      const ignorePaths = options.ignorePaths ?? DEFAULT_IGNORE_PATHS;

      if (ignorePaths.some((p) => filename.includes(p))) {
        return {};
      }

      if (isInShadcnUi(filename)) {
        return {};
      }

      const componentName = getComponentName(filename);

      if (!componentName) {
        return {};
      }

      return {
        "Program:exit"(node) {
          const dir = dirname(filename);
          const requiredSiblings = options.requiredSiblings ?? DEFAULT_SIBLINGS;

          const missing: string[] = [];

          for (const sibling of requiredSiblings) {
            const siblingPath = sibling.replace("<Name>", componentName);
            const fullPath = join(dir, siblingPath);

            if (!existsSync(fullPath)) {
              missing.push(siblingPath);
            }
          }

          if (missing.length > 0) {
            context.report({
              node,
              messageId: "missingSiblings",
              data: {
                name: componentName,
                missing: missing.join(", "),
              },
            });
          }
        },
      };
    },
  }
);
