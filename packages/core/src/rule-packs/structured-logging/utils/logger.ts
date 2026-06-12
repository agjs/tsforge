import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

export const DEFAULT_LOGGER_NAMES: readonly string[] = [
  "logger",
  "log",
  "reqLogger",
  "requestLogger",
];

export const DEFAULT_LOGGER_METHODS: readonly string[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

/**
 * Returns the matched method name when `node` is a logger call —
 * `<id>.<method>(...)` where the receiver name is in `loggerNames`
 * and the method is in `loggerMethods`. Returns null otherwise.
 *
 * Best-effort: we don't try to resolve types. A symbol named `logger`
 * is the strong convention; project-specific aliases (e.g. `reqLogger`
 * from `logger.child(...)`) are configurable via `loggerNames`.
 */
export function matchLoggerCall(
  node: TSESTree.CallExpression,
  loggerNames: ReadonlySet<string>,
  loggerMethods: ReadonlySet<string>
): string | null {
  const callee = node.callee;

  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) {
    return null;
  }

  if (callee.property.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  if (!loggerMethods.has(callee.property.name)) {
    return null;
  }

  const receiver = unwrapReceiver(callee.object);

  if (!receiver) {
    return null;
  }

  if (!loggerNames.has(receiver)) {
    return null;
  }

  return callee.property.name;
}

/**
 * Walks down a possibly-chained MemberExpression, returning the
 * leftmost identifier name. Catches `this.logger.info(...)`,
 * `ctx.log.info(...)`, etc. (returns "logger" / "log" — useful when
 * those names are in the configured set).
 */
function unwrapReceiver(node: TSESTree.Expression): string | null {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return node.name;
  }

  if (
    node.type === AST_NODE_TYPES.MemberExpression &&
    !node.computed &&
    node.property.type === AST_NODE_TYPES.Identifier
  ) {
    return node.property.name;
  }

  return null;
}

/**
 * Returns the second positional argument when it's an ObjectExpression
 * — that's where structured-logging payloads live. Many loggers also
 * accept `(obj, message)` (e.g. pino) — handle both shapes by checking
 * the FIRST arg if no ObjectExpression is found at index 1.
 */
export function getStructuredPayload(
  node: TSESTree.CallExpression
): TSESTree.ObjectExpression | null {
  const second = node.arguments[1];

  if (second?.type === AST_NODE_TYPES.ObjectExpression) {
    return second;
  }

  const first = node.arguments[0];

  if (first?.type === AST_NODE_TYPES.ObjectExpression) {
    return first;
  }

  return null;
}
