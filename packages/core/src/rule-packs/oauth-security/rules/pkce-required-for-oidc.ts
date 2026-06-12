import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { createRule } from "../../create-rule";
import {
  DEFAULT_OIDC_PROVIDERS,
  DEFAULT_PROVIDERS_GLOB,
  DEFAULT_VERIFIER_FN_NAMES,
  matchesAnyGlobPattern,
  toPosixRelative,
} from "../utils";

export const RULE_NAME = "pkce-required-for-oidc";

export interface PkceRequiredForOidcOptions {
  readonly providersGlob?: string;
  readonly oidcProviders?: readonly string[];
  readonly verifierFnNames?: readonly string[];
}

type RuleOptions = [PkceRequiredForOidcOptions];
type MessageIds = "missingPkce";

const optionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    providersGlob: { type: "string", minLength: 1 },
    oidcProviders: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
    verifierFnNames: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

const BUILD_FN_RE = /^(buildAuthorizationURL|getAuthorizationURL)$/;

type FunctionLike =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

function getFunctionName(node: FunctionLike): string | null {
  if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id !== null) {
    return node.id.name;
  }

  const parent = node.parent;

  if (parent === undefined) {
    return null;
  }

  if (
    parent.type === AST_NODE_TYPES.VariableDeclarator &&
    parent.id.type === AST_NODE_TYPES.Identifier
  ) {
    return parent.id.name;
  }

  if (
    parent.type === AST_NODE_TYPES.MethodDefinition &&
    parent.key.type === AST_NODE_TYPES.Identifier
  ) {
    return parent.key.name;
  }

  if (
    parent.type === AST_NODE_TYPES.Property &&
    parent.key.type === AST_NODE_TYPES.Identifier
  ) {
    return parent.key.name;
  }

  return null;
}

export const pkceRequiredForOidcRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: "problem",
    docs: {
      description:
        "OIDC providers must use PKCE: `buildAuthorizationURL` must call `generateCodeVerifier()` and pass it to `createAuthorizationURL`.",
    },
    schema: [optionSchema],
    messages: {
      missingPkce:
        "{{providerClass}} is OIDC — pass a PKCE `codeVerifier` to `createAuthorizationURL(state, verifier, scopes)`.",
    },
  },
  defaultOptions: [
    {
      providersGlob: DEFAULT_PROVIDERS_GLOB,
      oidcProviders: [...DEFAULT_OIDC_PROVIDERS],
      verifierFnNames: [...DEFAULT_VERIFIER_FN_NAMES],
    },
  ],
  create(context, [options]) {
    const providersGlob = options.providersGlob ?? DEFAULT_PROVIDERS_GLOB;
    const oidcProviders = new Set(
      options.oidcProviders ?? DEFAULT_OIDC_PROVIDERS
    );
    const verifierFnNames = new Set(
      options.verifierFnNames ?? DEFAULT_VERIFIER_FN_NAMES
    );

    const relative = toPosixRelative(context.filename, context.cwd);

    if (!matchesAnyGlobPattern(relative, [providersGlob])) {
      return {};
    }

    let importedOidcProvider: string | null = null;
    const verifierLocalNames = new Set<string>();

    interface FrameInfo {
      readonly node: FunctionLike;
      readonly name: string;
      verifierIdentifiers: Set<string>;
      hasCreateAuthorizationCallWithVerifier: boolean;
      hasCreateAuthorizationCall: boolean;
    }

    const stack: FrameInfo[] = [];

    function visitFn(node: FunctionLike): void {
      const name = getFunctionName(node);

      if (name === null || !BUILD_FN_RE.test(name)) {
        return;
      }

      stack.push({
        node,
        name,
        verifierIdentifiers: new Set(),
        hasCreateAuthorizationCallWithVerifier: false,
        hasCreateAuthorizationCall: false,
      });
    }

    function exitFn(node: FunctionLike): void {
      const top = stack[stack.length - 1];

      if (top?.node !== node) {
        return;
      }

      stack.pop();

      if (importedOidcProvider === null) {
        return;
      }

      if (
        top.hasCreateAuthorizationCall &&
        !top.hasCreateAuthorizationCallWithVerifier
      ) {
        context.report({
          node,
          messageId: "missingPkce",
          data: { providerClass: importedOidcProvider },
        });
      }
    }

    return {
      ImportDeclaration(node) {
        for (const spec of node.specifiers) {
          if (spec.type !== AST_NODE_TYPES.ImportSpecifier) {
            continue;
          }

          if (spec.imported.type !== AST_NODE_TYPES.Identifier) {
            continue;
          }

          if (oidcProviders.has(spec.imported.name)) {
            importedOidcProvider = spec.imported.name;
          }

          if (verifierFnNames.has(spec.imported.name)) {
            verifierLocalNames.add(spec.local.name);
          }
        }
      },

      FunctionDeclaration: visitFn,
      "FunctionDeclaration:exit": exitFn,
      FunctionExpression: visitFn,
      "FunctionExpression:exit": exitFn,
      ArrowFunctionExpression: visitFn,
      "ArrowFunctionExpression:exit": exitFn,

      VariableDeclarator(node) {
        if (stack.length === 0) {
          return;
        }

        const top = stack[stack.length - 1];

        if (top === undefined) {
          return;
        }

        if (
          node.id.type === AST_NODE_TYPES.Identifier &&
          node.init !== null &&
          node.init.type === AST_NODE_TYPES.AwaitExpression &&
          node.init.argument.type === AST_NODE_TYPES.CallExpression
        ) {
          const callee = node.init.argument.callee;

          if (
            callee.type === AST_NODE_TYPES.Identifier &&
            verifierLocalNames.has(callee.name)
          ) {
            top.verifierIdentifiers.add(node.id.name);
          }
        }

        if (
          node.id.type === AST_NODE_TYPES.Identifier &&
          node.init !== null &&
          node.init.type === AST_NODE_TYPES.CallExpression
        ) {
          const callee = node.init.callee;

          if (
            callee.type === AST_NODE_TYPES.Identifier &&
            verifierLocalNames.has(callee.name)
          ) {
            top.verifierIdentifiers.add(node.id.name);
          }
        }
      },

      CallExpression(node) {
        if (stack.length === 0) {
          return;
        }

        const top = stack[stack.length - 1];

        if (top === undefined) {
          return;
        }

        const callee = node.callee;

        if (
          callee.type !== AST_NODE_TYPES.MemberExpression ||
          callee.computed ||
          callee.property.type !== AST_NODE_TYPES.Identifier ||
          callee.property.name !== "createAuthorizationURL"
        ) {
          return;
        }

        top.hasCreateAuthorizationCall = true;

        // Inspect args. In arctic OIDC providers the signature is:
        //   createAuthorizationURL(state, codeVerifier, scopes)
        // The non-OIDC version is:
        //   createAuthorizationURL(state, scopes)
        // Detect PKCE by: 2nd arg is a verifier identifier we've tracked,
        // OR the call has 3 positional args (heuristic).
        const second = node.arguments[1];

        if (
          second?.type === AST_NODE_TYPES.Identifier &&
          (top.verifierIdentifiers.has(second.name) ||
            verifierLocalNames.has(second.name))
        ) {
          top.hasCreateAuthorizationCallWithVerifier = true;

          return;
        }

        if (node.arguments.length >= 3) {
          // Conservative — assume the 3-arg form is the OIDC variant.
          top.hasCreateAuthorizationCallWithVerifier = true;
        }
      },
    };
  },
});
