import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  componentNameFromProgram,
  isComponentFile,
  isInShadcnUi,
  isRouteFile,
  programDeclaresComponent,
} from "../utils";

export const RULE_NAME = "component-folder-structure";

export interface ComponentFolderStructureOptions {
  /** Substrings; a component file whose path matches any is left alone. */
  readonly ignorePaths?: readonly string[];
}

type RuleOptions = [ComponentFolderStructureOptions];
type MessageIds = "wrongLocation";

const DEFAULT_IGNORE_PATHS = ["tests/", "e2e/", ".storybook/", "node_modules"];

/** Feature components under views/ or features/ (boringstack + house style). */
const FEATURE_COMPONENT = /(^|\/)src\/(?:views|features)\/[^/]+\/components\//;

/** View/feature roots: src/views/<Feature>/index.tsx or src/features/<Feature>/index.tsx */
const FEATURE_VIEW_ROOT = /(^|\/)src\/(?:views|features)\/[^/]+\/index\.tsx$/;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
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
          "A component .tsx must live in src/views/<Feature>/components/ or src/features/<Feature>/components/ (feature component), src/components/ui/ (shared primitive), or be the view root src/views|features/<Feature>/index.tsx",
      },
      schema: [optionSchema],
      messages: {
        wrongLocation:
          "Component '{{name}}' is in the wrong place. Put it in src/views/<Feature>/components/{{name}}.tsx or src/features/<Feature>/components/{{name}}.tsx (a feature component), src/components/ui/ (a shared primitive), or make it the view root src/views|features/<Feature>/index.tsx — do NOT scatter components under {{dir}} (e.g. src/pages/).",
      },
    },
    defaultOptions: [{ ignorePaths: DEFAULT_IGNORE_PATHS }],
    create(context, [options]) {
      const filename = context.filename;

      if (!isComponentFile(filename)) {
        return {};
      }

      const ignorePaths = options.ignorePaths ?? DEFAULT_IGNORE_PATHS;

      if (ignorePaths.some((p) => filename.includes(p))) {
        return {};
      }

      if (
        isInShadcnUi(filename) ||
        isRouteFile(filename) ||
        FEATURE_COMPONENT.test(filename) ||
        FEATURE_VIEW_ROOT.test(filename)
      ) {
        return {};
      }

      const slash = filename.lastIndexOf("/");
      const dir = slash === -1 ? "." : filename.slice(0, slash);

      return {
        "Program:exit"(node) {
          if (!programDeclaresComponent(node)) {
            return;
          }

          const componentName = componentNameFromProgram(node) ?? "Component";

          context.report({
            node,
            messageId: "wrongLocation",
            data: { name: componentName, dir },
          });
        },
      };
    },
  }
);
