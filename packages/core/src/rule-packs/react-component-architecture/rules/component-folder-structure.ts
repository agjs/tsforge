import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  getComponentName,
  isComponentFile,
  isInShadcnUi,
  isRouteFile,
} from "../utils";

export const RULE_NAME = "component-folder-structure";

export interface ComponentFolderStructureOptions {
  /** Substrings; a component file whose path matches any is left alone. */
  readonly ignorePaths?: readonly string[];
}

type RuleOptions = [ComponentFolderStructureOptions];
type MessageIds = "wrongLocation";

const DEFAULT_IGNORE_PATHS = ["tests/", "e2e/", ".storybook/", "node_modules"];

/** A feature component lives at src/views/<Feature>/components/<X>.tsx (nesting
 *  under components/ is allowed). The view root is src/views/<Feature>/index.tsx
 *  (lowercase ⇒ not a PascalCase component file, so it never reaches here). */
const FEATURE_COMPONENT = /(^|\/)src\/views\/[^/]+\/components\//;

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
          "A component .tsx must live in src/views/<Feature>/components/ (feature component), src/components/ui/ (shared primitive), or be the view root src/views/<Feature>/index.tsx",
      },
      schema: [optionSchema],
      messages: {
        wrongLocation:
          "Component '{{name}}' is in the wrong place. Put it in src/views/<Feature>/components/{{name}}.tsx (a feature component), src/components/ui/ (a shared primitive), or make it the view root src/views/<Feature>/index.tsx — do NOT scatter components under {{dir}}.",
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

      // Allowed homes: shared primitives, generated route shells, feature
      // components. Anything else is a scattered/mis-placed component.
      if (
        isInShadcnUi(filename) ||
        isRouteFile(filename) ||
        FEATURE_COMPONENT.test(filename)
      ) {
        return {};
      }

      const componentName = getComponentName(filename);

      if (componentName === null) {
        return {};
      }

      const slash = filename.lastIndexOf("/");
      const dir = slash === -1 ? "." : filename.slice(0, slash);

      return {
        "Program:exit"(node) {
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
