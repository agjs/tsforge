import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

export const ROUTE_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
  "all",
  "ws",
]);

export const HOOK_METHODS = new Set([
  "onRequest",
  "onParse",
  "onTransform",
  "onBeforeHandle",
  "resolve",
  "onAfterHandle",
  "mapResponse",
  "onError",
  "onAfterResponse",
  "trace",
]);

type FunctionLike =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression
  | TSESTree.FunctionDeclaration;

export function isNewElysiaExpression(
  node: TSESTree.Node | null | undefined
): node is TSESTree.NewExpression {
  return (
    !!node &&
    node.type === AST_NODE_TYPES.NewExpression &&
    node.callee.type === AST_NODE_TYPES.Identifier &&
    node.callee.name === "Elysia"
  );
}

export function getChainRoot(
  node: TSESTree.CallExpression | TSESTree.MemberExpression
): TSESTree.Expression {
  let current: TSESTree.Expression = node;

  while (
    current.type === AST_NODE_TYPES.CallExpression ||
    current.type === AST_NODE_TYPES.MemberExpression
  ) {
    if (current.type === AST_NODE_TYPES.CallExpression) {
      current = current.callee;
      continue;
    }

    current = current.object;
  }

  return current;
}

export function collectElysiaVariables(program: TSESTree.Program): Set<string> {
  const elysiaVars = new Set<string>();

  for (const stmt of program.body) {
    visitDeclarations(stmt, elysiaVars);
  }

  return elysiaVars;
}

function visitDeclarations(stmt: TSESTree.Node, elysiaVars: Set<string>): void {
  if (stmt.type === AST_NODE_TYPES.VariableDeclaration) {
    for (const declarator of stmt.declarations) {
      if (
        declarator.id.type === AST_NODE_TYPES.Identifier &&
        declarator.init &&
        chainRootIsNewElysia(declarator.init)
      ) {
        elysiaVars.add(declarator.id.name);
      }
    }

    return;
  }

  if (stmt.type === AST_NODE_TYPES.ExportNamedDeclaration && stmt.declaration) {
    visitDeclarations(stmt.declaration, elysiaVars);

    return;
  }

  if (stmt.type === AST_NODE_TYPES.ExportDefaultDeclaration) {
    return;
  }
}

function chainRootIsNewElysia(expression: TSESTree.Expression): boolean {
  if (expression.type === AST_NODE_TYPES.NewExpression) {
    return isNewElysiaExpression(expression);
  }

  if (
    expression.type === AST_NODE_TYPES.CallExpression ||
    expression.type === AST_NODE_TYPES.MemberExpression
  ) {
    const root = getChainRoot(expression);

    return isNewElysiaExpression(root);
  }

  return false;
}

export function isElysiaRouted(
  call: TSESTree.CallExpression,
  elysiaVars: Set<string>
): boolean {
  if (call.callee.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }

  const root = getChainRoot(call);

  if (isNewElysiaExpression(root)) {
    return true;
  }

  if (root.type === AST_NODE_TYPES.Identifier && elysiaVars.has(root.name)) {
    return true;
  }

  return false;
}

export function getMemberMethodName(
  call: TSESTree.CallExpression
): string | null {
  if (
    call.callee.type === AST_NODE_TYPES.MemberExpression &&
    call.callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    return call.callee.property.name;
  }

  return null;
}

export function isElysiaRouteCall(
  call: TSESTree.CallExpression,
  elysiaVars: Set<string>
): boolean {
  const method = getMemberMethodName(call);

  return (
    method !== null &&
    ROUTE_METHODS.has(method) &&
    isElysiaRouted(call, elysiaVars)
  );
}

export function isElysiaHookCall(
  call: TSESTree.CallExpression,
  elysiaVars: Set<string>
): boolean {
  const method = getMemberMethodName(call);

  return (
    method !== null &&
    HOOK_METHODS.has(method) &&
    isElysiaRouted(call, elysiaVars)
  );
}

export function getRouteMethod(call: TSESTree.CallExpression): string | null {
  const method = getMemberMethodName(call);

  return method && ROUTE_METHODS.has(method) ? method : null;
}

export function getRoutePathLiteral(
  call: TSESTree.CallExpression
): string | null {
  const arg = call.arguments[0];

  if (arg?.type === AST_NODE_TYPES.Literal && typeof arg.value === "string") {
    return arg.value;
  }

  return null;
}

export function getRouteHandlerFunction(
  call: TSESTree.CallExpression
): FunctionLike | null {
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const arg = call.arguments[i];

    if (
      arg &&
      (arg.type === AST_NODE_TYPES.ArrowFunctionExpression ||
        arg.type === AST_NODE_TYPES.FunctionExpression)
    ) {
      return arg;
    }
  }

  return null;
}

export function getRouteOptionsObject(
  call: TSESTree.CallExpression
): TSESTree.ObjectExpression | null {
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const arg = call.arguments[i];

    if (arg?.type === AST_NODE_TYPES.ObjectExpression) {
      return arg;
    }
  }

  return null;
}

export function findEnclosingRouteHandler(
  node: TSESTree.Node,
  elysiaVars: Set<string>
): {
  readonly fn: FunctionLike;
  readonly routeCall: TSESTree.CallExpression;
} | null {
  let current: TSESTree.Node | undefined = node.parent;

  while (current) {
    if (
      (current.type === AST_NODE_TYPES.ArrowFunctionExpression ||
        current.type === AST_NODE_TYPES.FunctionExpression) &&
      current.parent?.type === AST_NODE_TYPES.CallExpression &&
      current.parent.arguments.includes(current) &&
      isElysiaRouteCall(current.parent, elysiaVars)
    ) {
      return { fn: current, routeCall: current.parent };
    }

    current = current.parent;
  }

  return null;
}

export function getCalleeName(node: TSESTree.CallExpression): string | null {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name;
  }

  if (
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    if (node.callee.object.type === AST_NODE_TYPES.Identifier) {
      return `${node.callee.object.name}.${node.callee.property.name}`;
    }

    if (
      node.callee.object.type === AST_NODE_TYPES.MemberExpression &&
      node.callee.object.object.type === AST_NODE_TYPES.Identifier &&
      node.callee.object.property.type === AST_NODE_TYPES.Identifier
    ) {
      return `${node.callee.object.object.name}.${node.callee.object.property.name}.${node.callee.property.name}`;
    }

    return node.callee.property.name;
  }

  return null;
}

export function findObjectProperty(
  obj: TSESTree.ObjectExpression,
  name: string
): TSESTree.Property | null {
  for (const property of obj.properties) {
    if (property.type !== AST_NODE_TYPES.Property) {
      continue;
    }

    if (
      property.key.type === AST_NODE_TYPES.Identifier &&
      property.key.name === name
    ) {
      return property;
    }

    if (
      property.key.type === AST_NODE_TYPES.Literal &&
      property.key.value === name
    ) {
      return property;
    }
  }

  return null;
}
