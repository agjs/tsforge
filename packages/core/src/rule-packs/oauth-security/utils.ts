import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import {
  matchesAnyGlobPattern,
  toPosixRelative as sharedToPosixRelative,
} from "../utils";

export const DEFAULT_REDIS_METHODS: readonly string[] = [
  "set",
  "setex",
  "setEx",
  "SETEX",
  "SET",
];

export const DEFAULT_OIDC_PROVIDERS: readonly string[] = [
  "Google",
  "Apple",
  "Microsoft",
  "MicrosoftEntraId",
  "Auth0",
  "Okta",
  "Cognito",
];

export const DEFAULT_VERIFIER_FN_NAMES: readonly string[] = [
  "generateCodeVerifier",
];

export const DEFAULT_STATE_FILES: readonly string[] = [
  "**/oauth/state.ts",
  "**/oauth/oauth.state.ts",
];

export const DEFAULT_PROVIDERS_GLOB = "**/oauth/providers/**";

export { sharedToPosixRelative as toPosixRelative, matchesAnyGlobPattern };

/**
 * Returns true when the receiver of `<id>.<method>(...)` looks like a Redis
 * client by name heuristic — identifier ends with `redis`, `client`, or
 * exactly `redis`/`client` (case-insensitive).
 */
export function looksLikeRedisIdentifier(name: string): boolean {
  const lower = name.toLowerCase();

  return (
    lower === "redis" ||
    lower === "client" ||
    lower.endsWith("redis") ||
    lower.endsWith("client")
  );
}

/**
 * Returns true when an identifier name suggests a Redis-client accessor —
 * `getClient`, `getRedis`, `getOAuthStateRedis`, etc.
 */
function looksLikeRedisAccessor(name: string): boolean {
  const lower = name.toLowerCase();

  if (!lower.startsWith("get")) {
    return false;
  }

  return lower.endsWith("redis") || lower.endsWith("client");
}

/**
 * Returns the matched method name when `node` is `<id>.<method>(...)` with
 * a Redis-shaped receiver and a method in `methods`. The receiver may be
 * either an identifier (`redis.setex(...)`) or a call to a Redis-shaped
 * accessor (`getClient().setex(...)`).
 */
export function matchRedisCall(
  node: TSESTree.CallExpression,
  methods: ReadonlySet<string>
): { method: string; node: TSESTree.CallExpression } | null {
  const callee = node.callee;

  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) {
    return null;
  }

  if (callee.property.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  if (!methods.has(callee.property.name)) {
    return null;
  }

  // Walk through chained MemberExpressions to the leftmost segment.
  let receiver: TSESTree.Node = callee.object;

  while (receiver.type === AST_NODE_TYPES.MemberExpression) {
    receiver = receiver.object;
  }

  if (
    receiver.type === AST_NODE_TYPES.Identifier &&
    looksLikeRedisIdentifier(receiver.name)
  ) {
    return { method: callee.property.name, node };
  }

  if (receiver.type === AST_NODE_TYPES.CallExpression) {
    const inner = receiver.callee;

    if (
      inner.type === AST_NODE_TYPES.Identifier &&
      looksLikeRedisAccessor(inner.name)
    ) {
      return { method: callee.property.name, node };
    }

    if (
      inner.type === AST_NODE_TYPES.MemberExpression &&
      !inner.computed &&
      inner.property.type === AST_NODE_TYPES.Identifier &&
      looksLikeRedisAccessor(inner.property.name)
    ) {
      return { method: callee.property.name, node };
    }
  }

  return null;
}
