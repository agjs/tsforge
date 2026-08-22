import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import { matchesAnyGlobPattern, ruleRelativePath } from "../../utils";
import { isPhaserPackageSource, requireSource } from "../utils";

export const RULE_NAME = "no-phaser-import-in-pure-layers";

export interface INoPhaserImportInPureLayersOptions {
  readonly denyGlobs?: readonly string[];
  readonly allowGlobs?: readonly string[];
}

type RuleOptions = [INoPhaserImportInPureLayersOptions];
type MessageIds = "phaserInPureLayer";

export const DEFAULT_DENY_GLOBS = [
  "**/domain/**",
  "**/content/**",
  "**/shared/**",
  "**/features/**",
] as const;

export const DEFAULT_ALLOW_GLOBS = [
  "**/runtime/**",
  "**/app/**",
  "**/game/**",
  "**/scenes/**",
] as const;

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    denyGlobs: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
    allowGlobs: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
    },
  },
};

export const noPhaserImportInPureLayersRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "Do not import phaser from domain, content, shared, or features layers. Keep engine code in runtime, app, game, or scenes.",
    },
    schema: [optionSchema],
    messages: {
      phaserInPureLayer:
        "Do not import `phaser` from domain, content, shared, or features layers. Move engine code to runtime, app, game, or scenes.",
    },
  },
  defaultOptions: [
    {
      denyGlobs: [...DEFAULT_DENY_GLOBS],
      allowGlobs: [...DEFAULT_ALLOW_GLOBS],
    },
  ],
  create(context, [options]) {
    const denyGlobs = options.denyGlobs ?? DEFAULT_DENY_GLOBS;
    const allowGlobs = options.allowGlobs ?? DEFAULT_ALLOW_GLOBS;
    const relative = ruleRelativePath(context.filename, context.cwd);

    if (matchesAnyGlobPattern(relative, allowGlobs)) {
      return {};
    }

    if (!matchesAnyGlobPattern(relative, denyGlobs)) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== "string") {
          return;
        }

        if (!isPhaserPackageSource(node.source.value)) {
          return;
        }

        context.report({ node, messageId: "phaserInPureLayer" });
      },
      CallExpression(node) {
        const source = requireSource(node);

        if (source === null || !isPhaserPackageSource(source)) {
          return;
        }

        context.report({ node, messageId: "phaserInPureLayer" });
      },
    };
  },
});
