import type { TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { matchesAnyGlobPattern, toPosixRelative } from "../../utils";

export const RULE_NAME = "no-react-in-services";

export interface INoReactInServicesOptions {
  readonly serviceGlobs?: readonly string[];
  readonly forbiddenModules?: readonly string[];
}

type RuleOptions = [INoReactInServicesOptions];
type MessageIds = "reactInService";

const DEFAULT_SERVICE_GLOBS = [
  "**/services/**",
  "**/*.service.ts",
  "**/*.queries.ts",
] as const;

const DEFAULT_FORBIDDEN = ["react", "react-dom"] as const;

const DEFAULT_SERVICE_PATH_PATTERNS = [
  /(^|\/)services\//,
  /\.service\.tsx?$/,
  /\.queries\.ts$/,
] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    serviceGlobs: {
      type: "array",
      items: { type: "string" },
    },
    forbiddenModules: {
      type: "array",
      items: { type: "string" },
    },
  },
};

function isServiceFile(
  filename: string,
  cwd: string,
  globs: readonly string[]
): boolean {
  const rel = toPosixRelative(filename, cwd);

  if (DEFAULT_SERVICE_PATH_PATTERNS.some((pattern) => pattern.test(rel))) {
    return true;
  }

  return matchesAnyGlobPattern(rel, globs);
}

export const noReactInServicesRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Service and data-fetch modules must not import React — keep business logic decoupled from the view layer.",
    },
    schema: [optionSchema],
    messages: {
      reactInService:
        "Service/data layer file must not import `{{module}}` — keep React in components and hooks only.",
    },
  },
  defaultOptions: [
    {
      serviceGlobs: [...DEFAULT_SERVICE_GLOBS],
      forbiddenModules: [...DEFAULT_FORBIDDEN],
    },
  ],
  create(context, [options]) {
    const serviceGlobs = options.serviceGlobs ?? DEFAULT_SERVICE_GLOBS;
    const forbidden = new Set(options.forbiddenModules ?? DEFAULT_FORBIDDEN);
    const cwd = context.cwd;

    if (!isServiceFile(context.filename, cwd, serviceGlobs)) {
      return {};
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        const source = node.source.value;

        if (typeof source !== "string") {
          return;
        }

        const base = source.split("/")[0];

        if (base === undefined || !forbidden.has(base)) {
          return;
        }

        context.report({
          node,
          messageId: "reactInService",
          data: { module: base },
        });
      },
    };
  },
});
