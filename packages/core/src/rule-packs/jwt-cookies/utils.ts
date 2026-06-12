import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

const PATTERN_TYPES = new Set<string>([
  AST_NODE_TYPES.AssignmentPattern,
  AST_NODE_TYPES.RestElement,
  AST_NODE_TYPES.ArrayPattern,
  AST_NODE_TYPES.ObjectPattern,
  AST_NODE_TYPES.TSEmptyBodyFunctionExpression,
]);

function isExpression(node: TSESTree.Node): node is TSESTree.Expression {
  return !PATTERN_TYPES.has(node.type);
}

export const DEFAULT_AUTH_COOKIE_NAMES: readonly string[] = [
  "auth_token",
  "session",
  "sid",
  "authToken",
];

export const DEFAULT_TRUSTED_CONFIG_NAMES: readonly string[] = [
  "AUTH_COOKIE_CONFIG",
];

export const DEFAULT_SET_COOKIE_FUNCTIONS: readonly string[] = [
  "setCookie",
  "set",
];

export interface CookieSetCall {
  /**
   * Cookie name as a string. Empty string when the call form does not name
   * a cookie (caller must decide whether to flag — usually no).
   */
  readonly cookieName: string;
  /**
   * The ObjectExpression carrying cookie options (httpOnly, secure, ...).
   * `null` if the call form has no recognizable options object.
   */
  readonly optionsNode: TSESTree.ObjectExpression | null;
}

function getStringLiteral(node: TSESTree.Node | undefined): string | null {
  if (node?.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return node.value;
  }

  return null;
}

function getMemberPropertyName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }

  if (
    node.computed &&
    node.property.type === AST_NODE_TYPES.Literal &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }

  return null;
}

/**
 * Recognizes three call shapes:
 *
 *   1. `cookie.<name>.set({...})`        — Elysia / Hono style
 *   2. `set("<name>", value, {...})`     — generic helper
 *   3. `reply.setCookie("<name>", value, {...})`   — Fastify
 *
 * Returns null when the call doesn't match any known shape with an auth-named
 * cookie.
 */
export function matchAuthCookieSet(
  node: TSESTree.CallExpression,
  authCookieNames: ReadonlySet<string>,
  setCookieFunctions: ReadonlySet<string>
): CookieSetCall | null {
  const callee = node.callee;

  // Form 1: `cookie.<name>.set({...})`
  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "set" &&
    callee.object.type === AST_NODE_TYPES.MemberExpression
  ) {
    const innerName = getMemberPropertyName(callee.object);

    if (innerName !== null && authCookieNames.has(innerName)) {
      const arg = node.arguments[0];
      const optionsNode =
        arg?.type === AST_NODE_TYPES.ObjectExpression ? arg : null;

      return { cookieName: innerName, optionsNode };
    }
  }

  // Forms 2 + 3: helper-style calls.
  // Identifier callee: `set(...)`. MemberExpression callee: `reply.setCookie(...)`.
  let calleeName: string | null = null;

  if (callee.type === AST_NODE_TYPES.Identifier) {
    calleeName = callee.name;
  } else if (callee.type === AST_NODE_TYPES.MemberExpression) {
    calleeName = getMemberPropertyName(callee);
  }

  if (calleeName === null || !setCookieFunctions.has(calleeName)) {
    return null;
  }

  const cookieName = getStringLiteral(node.arguments[0]);

  if (cookieName === null || !authCookieNames.has(cookieName)) {
    return null;
  }

  // Options object is typically the last positional argument.
  const last = node.arguments[node.arguments.length - 1];
  const optionsNode =
    last?.type === AST_NODE_TYPES.ObjectExpression ? last : null;

  return { cookieName, optionsNode };
}

export interface PropertyValue {
  readonly value: TSESTree.Expression | null;
  readonly hasTrustedSpread: boolean;
}

/**
 * Returns the value node for `key` in the options object, plus whether the
 * options object spreads a trusted config identifier (which we treat as
 * "everything is set correctly").
 */
export function lookupCookieOption(
  options: TSESTree.ObjectExpression,
  key: string,
  trustedConfigNames: ReadonlySet<string>
): PropertyValue {
  let hasTrustedSpread = false;

  for (const prop of options.properties) {
    if (prop.type === AST_NODE_TYPES.SpreadElement) {
      if (
        prop.argument.type === AST_NODE_TYPES.Identifier &&
        trustedConfigNames.has(prop.argument.name)
      ) {
        hasTrustedSpread = true;
      }

      continue;
    }

    if (prop.type !== AST_NODE_TYPES.Property || prop.computed) {
      continue;
    }

    let propName: string | null = null;

    if (prop.key.type === AST_NODE_TYPES.Identifier) {
      propName = prop.key.name;
    } else if (
      prop.key.type === AST_NODE_TYPES.Literal &&
      typeof prop.key.value === "string"
    ) {
      propName = prop.key.value;
    }

    if (propName === key) {
      const value = prop.value;

      if (!isExpression(value)) {
        return { value: null, hasTrustedSpread };
      }

      return { value, hasTrustedSpread };
    }
  }

  return { value: null, hasTrustedSpread };
}
