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
  if (importSource.startsWith("@/")) {
    return importSource;
  }

  if (importSource.startsWith(".")) {
    let resolved = path.resolve(currentDir, importSource);

    resolved = resolved.replace(/\\/g, "/");

    for (const root of ["features", "views"] as const) {
      if (resolved.includes(`/src/${root}/`)) {
        const match = new RegExp(`^(.*)/src/${root}/([^/]+)(/.*)?$`).exec(
          resolved
        );

        if (match?.[2]) {
          const suffix = match[3] ?? "";

          return `@/${root}/${match[2]}${suffix}`;
        }
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
      description:
        "Prevent imports across different features under src/features or src/views",
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
    const roots =
      featuresDir === "src/features"
        ? (["src/features", "src/views"] as const)
        : ([featuresDir] as const);

    let currentFeature: string | null = null;

    for (const root of roots) {
      currentFeature = extractFeatureName(filename, root);

      if (currentFeature !== null) {
        break;
      }
    }

    if (currentFeature === null) {
      return {};
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (allowSiblingTypes && node.importKind === "type") {
          return;
        }

        const importSource = node.source.value;

        if (
          !importSource.includes("/features/") &&
          !importSource.includes("/views/")
        ) {
          return;
        }

        const currentDir = path.dirname(filename);
        const resolved = resolveImportSource(importSource, currentDir);

        if (
          resolved === null ||
          (!resolved.includes("/features/") && !resolved.includes("/views/"))
        ) {
          return;
        }

        const match = /\/(?:features|views)\/([^/]+)/.exec(resolved);
        const importedFeature = match?.[1] ?? null;

        if (importedFeature === null || importedFeature === currentFeature) {
          return;
        }

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
