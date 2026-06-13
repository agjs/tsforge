import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4 } from "@typescript-eslint/utils/json-schema";

import { walkSome } from "../utils";

export const DEFAULT_AUTHZ_FUNCTIONS = [
  "requireUser",
  "authorize",
  "requireAuth",
  "assertAuthorized",
] as const;

export interface IAuthzOptions {
  readonly authzFunctions?: readonly string[];
}

export type AuthzRuleOptions = [IAuthzOptions];

export const authzOptionSchema: JSONSchema4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    authzFunctions: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      minItems: 1,
    },
  },
};

export const MUTATING_HTTP_METHODS = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const DB_MUTATION_METHODS = new Set(["update", "insert", "delete"]);
const DB_QUERY_METHODS = new Set([
  "select",
  "query",
  "findFirst",
  "findMany",
  "findUnique",
  "get",
  "execute",
]);

export function defaultAuthzOptions(): IAuthzOptions {
  return { authzFunctions: [...DEFAULT_AUTHZ_FUNCTIONS] };
}

export function resolveAuthzFunctions(options: IAuthzOptions): Set<string> {
  return new Set(options.authzFunctions ?? DEFAULT_AUTHZ_FUNCTIONS);
}

export function calleeName(callee: TSESTree.Node): string | null {
  if (callee.type === AST_NODE_TYPES.Identifier) {
    return callee.name;
  }

  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    return callee.property.name;
  }

  return null;
}

export function isAuthzCall(
  node: TSESTree.CallExpression,
  authzNames: Set<string>
): boolean {
  const name = calleeName(node.callee);

  return name !== null && authzNames.has(name);
}

export function containsAuthzCall(
  root: TSESTree.Node,
  authzNames: Set<string>
): boolean {
  return walkSome(
    root,
    (node) =>
      node.type === AST_NODE_TYPES.CallExpression &&
      isAuthzCall(node, authzNames)
  );
}

export function isRouteHandlerFile(filename: string): boolean {
  const base = filename.split(/[\\/]/).pop() ?? "";

  return /^route\.(?:tsx|ts|jsx|js)$/.test(base);
}

export function hasUseServerDirective(program: TSESTree.Program): boolean {
  for (const stmt of program.body) {
    if (
      stmt.type !== AST_NODE_TYPES.ExpressionStatement ||
      stmt.expression.type !== AST_NODE_TYPES.Literal ||
      typeof stmt.expression.value !== "string"
    ) {
      return false;
    }

    if (stmt.expression.value === "use server") {
      return true;
    }
  }

  return false;
}

function dbReceiverName(callee: TSESTree.MemberExpression): string | null {
  const object = callee.object;

  if (object.type === AST_NODE_TYPES.Identifier) {
    return object.name;
  }

  if (
    object.type === AST_NODE_TYPES.MemberExpression &&
    !object.computed &&
    object.property.type === AST_NODE_TYPES.Identifier
  ) {
    return object.property.name;
  }

  return null;
}

function looksLikeDbReceiver(name: string | null): boolean {
  if (name === null) {
    return false;
  }

  return name === "db" || name === "tx" || name.endsWith("Db");
}

export function isDbMutationCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) {
    return false;
  }

  const method = calleeName(callee);

  if (method === null || !DB_MUTATION_METHODS.has(method)) {
    return false;
  }

  return looksLikeDbReceiver(dbReceiverName(callee));
}

export function isDbQueryCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;

  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) {
    return false;
  }

  const method = calleeName(callee);

  if (method === null || !DB_QUERY_METHODS.has(method)) {
    return false;
  }

  return looksLikeDbReceiver(dbReceiverName(callee));
}

export function isParamsIdRead(node: TSESTree.Node): boolean {
  if (node.type !== AST_NODE_TYPES.MemberExpression || node.computed) {
    return false;
  }

  const object = node.object;
  const property = node.property;

  if (
    object.type !== AST_NODE_TYPES.Identifier ||
    object.name !== "params" ||
    property.type !== AST_NODE_TYPES.Identifier ||
    property.name !== "id"
  ) {
    return false;
  }

  return true;
}

export type FunctionLike =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

export function getExportedMutatingHandlerName(
  node: TSESTree.Node
): string | null {
  if (node.type === AST_NODE_TYPES.ExportNamedDeclaration) {
    const declaration = node.declaration;

    if (declaration === null) {
      return null;
    }

    if (declaration.type === AST_NODE_TYPES.FunctionDeclaration) {
      return getMutatingHandlerNameFromFunction(declaration);
    }

    if (declaration.type === AST_NODE_TYPES.VariableDeclaration) {
      for (const declarator of declaration.declarations) {
        const name = getMutatingHandlerNameFromVariableDeclarator(declarator);

        if (name !== null) {
          return name;
        }
      }
    }

    return null;
  }

  if (
    node.type === AST_NODE_TYPES.FunctionDeclaration &&
    node.parent?.type === AST_NODE_TYPES.ExportNamedDeclaration
  ) {
    return getMutatingHandlerNameFromFunction(node);
  }

  return null;
}

function getMutatingHandlerNameFromFunction(
  node: TSESTree.FunctionDeclaration
): string | null {
  if (node.id === null) {
    return null;
  }

  if (!MUTATING_HTTP_METHODS.has(node.id.name)) {
    return null;
  }

  return node.id.name;
}

function getMutatingHandlerNameFromVariableDeclarator(
  node: TSESTree.VariableDeclarator
): string | null {
  if (node.id.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  if (!MUTATING_HTTP_METHODS.has(node.id.name)) {
    return null;
  }

  const init = node.init;

  if (
    init === null ||
    (init.type !== AST_NODE_TYPES.FunctionExpression &&
      init.type !== AST_NODE_TYPES.ArrowFunctionExpression)
  ) {
    return null;
  }

  return node.id.name;
}

export function getFunctionLikeBody(
  node: FunctionLike
): TSESTree.BlockStatement | TSESTree.Expression | null {
  if (node.type === AST_NODE_TYPES.ArrowFunctionExpression) {
    return node.body;
  }

  return node.body;
}
