import type { TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";
import * as path from "path";

import { createRule } from "../../create-rule";

export const RULE_NAME = "no-cross-feature-imports";

export interface NoCrossFeatureImportsOptions {
  readonly featuresDir?: string;
  readonly allowSiblingTypes?: boolean;
  readonly allowList?: readonly (readonly [string, string])[];
}

type RuleOptions = [NoCrossFeatureImportsOptions];
type MessageIds = "crossFeatureImport";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    featuresDir: {
      type: "string",
    },
    allowSiblingTypes: {
      type: "boolean",
    },
    allowList: {
      type: "array",
      items: {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: { type: "string" },
      },
    },
  },
};

function extractFeatureName(
  filename: string,
  featuresDir: string
): string | null {
  const normalized = filename.replace(/\\/g, "/");
  const featuresDirNorm = featuresDir.replace(/\\/g, "/");

  // Match: <anything>/src/features/<featureName>/...
  const pattern = new RegExp(
    `(^|/)${featuresDirNorm.split("/").join("/")}[/]([^/]+)[/]`
  );
  const match = normalized.match(pattern);

  return match?.[2] ?? null;
}

function resolveImportSource(
  importSource: string,
  currentDir: string
): string | null {
  // Handle @/ alias
  if (importSource.startsWith("@/")) {
    return importSource;
  }

  // Handle relative imports
  if (importSource.startsWith(".")) {
    let resolved = path.resolve(currentDir, importSource);

    resolved = resolved.replace(/\\/g, "/");

    // Normalize to @/ format if it resolves to features
    if (resolved.includes("/src/features/")) {
      const match = /^(.*)\/src\/features\/([^/]+)(\/.*)?$/.exec(resolved);

      if (match?.[2]) {
        const suffix = match[3] ?? "";

        return `@/features/${match[2]}${suffix}`;
      }
    }

    return resolved;
  }

  return importSource;
}

export const noCrossFeatureImportsRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description: "Prevent imports across different features",
    },
    schema: [optionSchema],
    messages: {
      crossFeatureImport:
        'Feature "{{from}}" must not import from feature "{{to}}". Shared code belongs in @/lib or @/components.',
    },
  },
  defaultOptions: [
    {
      featuresDir: "src/features",
      allowSiblingTypes: true,
      allowList: [],
    },
  ],
  create(context, [options]) {
    const featuresDir = options.featuresDir ?? "src/features";
    const allowSiblingTypes = options.allowSiblingTypes ?? true;
    const allowList = new Set(
      (options.allowList ?? []).map((pair) => pair.join("→"))
    );

    const filename = context.filename;
    const currentFeature = extractFeatureName(filename, featuresDir);

    // Only check files inside features
    if (!currentFeature) {
      return {};
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        // If allowSiblingTypes is true and this is a type-only import, skip
        if (allowSiblingTypes && node.importKind === "type") {
          return;
        }

        const importSource = node.source.value;

        // Check if this is a feature import
        if (!importSource.includes("/features/")) {
          return;
        }

        const currentDir = path.dirname(filename);
        const resolved = resolveImportSource(importSource, currentDir);

        if (!resolved?.includes("/features/")) {
          return;
        }

        // Extract feature name from import
        const match = /\/features\/([^/]+)/.exec(resolved);
        const importedFeature = match ? match[1] : null;

        if (!importedFeature || importedFeature === currentFeature) {
          return;
        }

        // Check if this is in the allow list
        const allowKey = `${currentFeature}→${importedFeature}`;

        if (allowList.has(allowKey)) {
          return;
        }

        context.report({
          node,
          messageId: "crossFeatureImport",
          data: {
            from: currentFeature,
            to: importedFeature,
          },
        });
      },
    };
  },
});
