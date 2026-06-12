import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";

type MessageIds = "missingKey" | "dictionaryReadFailed";

export interface StaticTranslationKeyExistsOptions {
  readonly dictionary: string;
}

type RuleOptions = [StaticTranslationKeyExistsOptions];

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  required: ["dictionary"],
  properties: {
    dictionary: { type: "string", minLength: 1 },
  },
};

function collectLeafKeys(
  value: unknown,
  prefix: string,
  out: Set<string>
): void {
  if (typeof value === "string") {
    if (prefix !== "") {
      out.add(prefix);
    }

    return;
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  for (const [k, v] of Object.entries(value)) {
    const next = prefix === "" ? k : `${prefix}.${k}`;

    collectLeafKeys(v, next, out);
  }
}

function loadDictionary(pathFromRoot: string, cwd: string): Set<string> {
  const abs = isAbsolute(pathFromRoot)
    ? pathFromRoot
    : resolve(cwd, pathFromRoot);

  if (!existsSync(abs)) {
    throw new Error(`eslint-plugin-i18n-keys: dictionary not found: ${abs}`);
  }

  const raw = readFileSync(abs, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const keys = new Set<string>();

  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed)) {
      collectLeafKeys(v, k, keys);
    }
  }

  return keys;
}

function getStringLiteral(
  node: TSESTree.CallExpressionArgument | undefined
): string | null {
  if (node === undefined) {
    return null;
  }

  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return node.value;
  }

  return null;
}

function isTranslationCall(node: TSESTree.CallExpression): boolean {
  const { callee } = node;

  if (callee.type === AST_NODE_TYPES.Identifier && callee.name === "t") {
    return true;
  }

  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "t" &&
    callee.object.type === AST_NODE_TYPES.Identifier &&
    callee.object.name === "i18n"
  ) {
    return true;
  }

  return false;
}

export const staticTranslationKeyExistsRule = createRule<
  RuleOptions,
  MessageIds
>({
  name: "static-translation-key-exists",
  meta: {
    type: "problem",
    docs: {
      description:
        'Static string passed to `t("...")` or `i18n.t("...")` must exist as a leaf path in the canonical locale JSON.',
    },
    schema: [optionSchema],
    messages: {
      missingKey:
        'Translation key "{{key}}" is not defined in {{dictionary}} (static keys only; dynamic templates are not checked).',
      dictionaryReadFailed:
        "Could not read i18n dictionary at {{path}} (cwd: {{cwd}}).",
    },
  },
  defaultOptions: [{ dictionary: "src/lib/i18n/locales/en/common.json" }],
  create(context, [options]) {
    const cwd = context.cwd ?? process.cwd();
    let keys: Set<string> | undefined;

    try {
      keys = loadDictionary(options.dictionary, cwd);
    } catch {
      keys = undefined;
    }

    return {
      Program(node: TSESTree.Program): void {
        if (keys === undefined) {
          context.report({
            node,
            messageId: "dictionaryReadFailed",
            data: { path: options.dictionary, cwd },
          });
        }
      },
      CallExpression(node: TSESTree.CallExpression): void {
        if (keys === undefined) {
          return;
        }

        if (!isTranslationCall(node)) {
          return;
        }

        const key = getStringLiteral(node.arguments[0]);

        if (key === null || key === "") {
          return;
        }

        if (keys.has(key)) {
          return;
        }

        context.report({
          node: node.arguments[0] ?? node,
          messageId: "missingKey",
          data: { key, dictionary: options.dictionary },
        });
      },
    };
  },
});
