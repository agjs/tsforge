import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { walkSome } from "../../utils";

export const ROUTE_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
]);

export const MUTATING_METHODS = new Set(["post", "put", "patch"]);

/** Collect identifiers bound to a Fastify instance (`Fastify()` / `require('fastify')()`). */
export function collectFastifyVariables(
  program: TSESTree.Program
): Set<string> {
  const vars = new Set<string>();

  for (const statement of program.body) {
    if (statement.type !== AST_NODE_TYPES.VariableDeclaration) {
      continue;
    }

    for (const decl of statement.declarations) {
      if (decl.id.type !== AST_NODE_TYPES.Identifier || decl.init === null) {
        continue;
      }

      if (isFastifyFactoryCall(decl.init)) {
        vars.add(decl.id.name);
      }
    }
  }

  return vars;
}

function isFastifyFactoryCall(node: TSESTree.Expression): boolean {
  if (node.type !== AST_NODE_TYPES.CallExpression) {
    return false;
  }

  const callee = node.callee;

  if (callee.type === AST_NODE_TYPES.CallExpression) {
    return isFastifyFactoryCall(callee);
  }

  if (callee.type === AST_NODE_TYPES.Identifier && callee.name === "Fastify") {
    return true;
  }

  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier &&
    callee.property.name === "default" &&
    callee.object.type === AST_NODE_TYPES.Identifier &&
    callee.object.name === "Fastify"
  ) {
    return true;
  }

  return false;
}

export function getRouteMethodName(
  node: TSESTree.CallExpression,
  fastifyVars: ReadonlySet<string>
): string | null {
  const callee = node.callee;

  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) {
    return null;
  }

  if (
    callee.object.type !== AST_NODE_TYPES.Identifier ||
    !fastifyVars.has(callee.object.name)
  ) {
    return null;
  }

  if (callee.property.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  const method = callee.property.name;

  return ROUTE_METHODS.has(method) ? method : null;
}

export function findRouteOptionsArg(
  node: TSESTree.CallExpression
): TSESTree.ObjectExpression | null {
  const firstArg = node.arguments[0];

  if (
    firstArg?.type === AST_NODE_TYPES.ObjectExpression &&
    node.arguments.length >= 2
  ) {
    return firstArg;
  }

  const secondArg = node.arguments[1];

  if (secondArg?.type === AST_NODE_TYPES.ObjectExpression) {
    return secondArg;
  }

  return null;
}

export function findObjectProperty(
  object: TSESTree.ObjectExpression,
  keyName: string
): TSESTree.Property | null {
  for (const prop of object.properties) {
    if (prop.type !== AST_NODE_TYPES.Property || prop.computed) {
      continue;
    }

    const key = prop.key;

    if (key.type === AST_NODE_TYPES.Identifier && key.name === keyName) {
      return prop;
    }

    if (key.type === AST_NODE_TYPES.Literal && key.value === keyName) {
      return prop;
    }
  }

  return null;
}

export function findNestedProperty(
  object: TSESTree.ObjectExpression,
  ...keys: string[]
): TSESTree.Property | null {
  let current: TSESTree.ObjectExpression | null = object;

  for (let index = 0; index < keys.length; index += 1) {
    const keyName = keys[index];

    if (current === null || keyName === undefined) {
      return null;
    }

    const prop = findObjectProperty(current, keyName);

    if (prop === null) {
      return null;
    }

    if (index === keys.length - 1) {
      return prop;
    }

    if (prop.value.type === AST_NODE_TYPES.ObjectExpression) {
      current = prop.value;
    } else {
      return null;
    }
  }

  return null;
}

export function getRouteHandler(
  node: TSESTree.CallExpression
): TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression | null {
  for (const arg of node.arguments) {
    if (
      arg.type === AST_NODE_TYPES.ArrowFunctionExpression ||
      arg.type === AST_NODE_TYPES.FunctionExpression
    ) {
      return arg;
    }
  }

  return null;
}

export function nodeContainsCallNamed(
  root: TSESTree.Node,
  objectName: string,
  methodName: string
): boolean {
  return walkSome(root, (node) => {
    if (node.type !== AST_NODE_TYPES.CallExpression) {
      return false;
    }

    const callee = node.callee;

    return (
      callee.type === AST_NODE_TYPES.MemberExpression &&
      !callee.computed &&
      callee.object.type === AST_NODE_TYPES.Identifier &&
      callee.object.name === objectName &&
      callee.property.type === AST_NODE_TYPES.Identifier &&
      callee.property.name === methodName
    );
  });
}

export function nodeContainsMemberCall(
  root: TSESTree.Node,
  methodName: string
): boolean {
  return walkSome(root, (node) => {
    if (node.type !== AST_NODE_TYPES.CallExpression) {
      return false;
    }

    const callee = node.callee;

    return (
      callee.type === AST_NODE_TYPES.MemberExpression &&
      !callee.computed &&
      callee.property.type === AST_NODE_TYPES.Identifier &&
      callee.property.name === methodName
    );
  });
}
