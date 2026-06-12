import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { walkAll } from "../utils";

export { walkAll, walkSome } from "../utils";

/**
 * Helper utilities for BullMQ rules.
 */

export interface BullmqImports {
  hasBullmqImport: boolean;
  workerLocalNames: Set<string>;
  queueLocalNames: Set<string>;
  queueEventsLocalNames: Set<string>;
}

export interface QueueDefinition {
  bindingKey: string;
  defaultJobOptions?: TSESTree.ObjectExpression | null;
}

export interface WorkerDefinition {
  bindingKey: string | null;
  node: TSESTree.NewExpression;
}

export function analyzeBullmqImports(program: TSESTree.Program): BullmqImports {
  const result: BullmqImports = {
    hasBullmqImport: false,
    workerLocalNames: new Set(),
    queueLocalNames: new Set(),
    queueEventsLocalNames: new Set(),
  };

  for (const stmt of program.body) {
    if (stmt.type !== AST_NODE_TYPES.ImportDeclaration) {
      continue;
    }

    if (stmt.source.value !== "bullmq") {
      continue;
    }

    result.hasBullmqImport = true;

    for (const specifier of stmt.specifiers) {
      recordImportSpecifier(specifier, result);
    }
  }

  return result;
}

function recordImportSpecifier(
  specifier: TSESTree.ImportClause,
  result: BullmqImports
): void {
  if (specifier.type !== AST_NODE_TYPES.ImportSpecifier) {
    return;
  }

  if (specifier.imported.type !== AST_NODE_TYPES.Identifier) {
    return;
  }

  const target = {
    Worker: result.workerLocalNames,
    Queue: result.queueLocalNames,
    QueueEvents: result.queueEventsLocalNames,
  }[specifier.imported.name];

  target?.add(specifier.local.name);
}

function extractDefaultJobOptions(
  newExpr: TSESTree.NewExpression
): TSESTree.ObjectExpression | null {
  const opts = getOptionsObjectArg(newExpr, 1);

  if (!opts) {
    return null;
  }

  const property = findObjectProperty(opts, "defaultJobOptions");

  if (!property) {
    return null;
  }

  if (property.value.type === AST_NODE_TYPES.ObjectExpression) {
    return property.value;
  }

  return null;
}

function isNewQueue(
  node: TSESTree.Node,
  imports: BullmqImports
): node is TSESTree.NewExpression {
  if (node.type !== AST_NODE_TYPES.NewExpression) {
    return false;
  }

  if (node.callee.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  return imports.queueLocalNames.has(node.callee.name);
}

export function collectQueueDefinitions(
  program: TSESTree.Program,
  imports: BullmqImports
): Map<string, QueueDefinition> {
  const queues = new Map<string, QueueDefinition>();

  walkAll(program, (node) => {
    if (
      node.type === AST_NODE_TYPES.VariableDeclarator &&
      node.id.type === AST_NODE_TYPES.Identifier &&
      node.init &&
      isNewQueue(node.init, imports)
    ) {
      const varName = node.id.name;
      const firstArg = node.init.arguments[0];

      if (firstArg?.type === AST_NODE_TYPES.Literal) {
        const queueName = firstArg.value;

        if (typeof queueName === "string") {
          const defaultJobOptions = extractDefaultJobOptions(node.init);

          queues.set(varName, {
            bindingKey: varName,
            defaultJobOptions,
          });
        }
      }
    }
  });

  walkAll(program, (node) => {
    if (!isNewQueue(node, imports)) {
      return;
    }

    const firstArg = node.arguments[0];

    if (firstArg?.type !== AST_NODE_TYPES.Literal) {
      return;
    }

    const queueName = firstArg.value;

    if (typeof queueName !== "string") {
      return;
    }

    const defaultJobOptions = extractDefaultJobOptions(node);
    const { parent } = node;

    if (
      parent.type !== AST_NODE_TYPES.VariableDeclarator ||
      parent.id.type !== AST_NODE_TYPES.Identifier
    ) {
      queues.set(queueName, {
        bindingKey: queueName,
        defaultJobOptions,
      });
    }
  });

  return queues;
}

export function collectWorkerDefinitions(
  program: TSESTree.Program,
  imports: BullmqImports
): WorkerDefinition[] {
  const workers: WorkerDefinition[] = [];
  const varToWorkerMap = new Map<string, TSESTree.NewExpression>();

  walkAll(program, (node) => {
    if (
      node.type === AST_NODE_TYPES.VariableDeclarator &&
      node.id.type === AST_NODE_TYPES.Identifier &&
      node.init &&
      isNewWorker(node.init, imports)
    ) {
      varToWorkerMap.set(node.id.name, node.init);
    }
  });

  walkAll(program, (node) => {
    if (!isNewWorker(node, imports)) {
      return;
    }

    const bindingKey = workerBindingKey(node.parent);

    workers.push({
      bindingKey,
      node,
    });
  });

  return workers;
}

function workerBindingKey(parent: TSESTree.Node): string | null {
  if (
    parent.type === AST_NODE_TYPES.VariableDeclarator &&
    parent.id.type === AST_NODE_TYPES.Identifier
  ) {
    return parent.id.name;
  }

  if (parent.type === AST_NODE_TYPES.PropertyDefinition) {
    if (parent.key.type === AST_NODE_TYPES.Identifier && !parent.computed) {
      return `this.${parent.key.name}`;
    }

    if (
      parent.key.type === AST_NODE_TYPES.Literal &&
      typeof parent.key.value === "string"
    ) {
      return `this.${parent.key.value}`;
    }

    return null;
  }

  if (parent.type === AST_NODE_TYPES.AssignmentExpression) {
    if (parent.left.type === AST_NODE_TYPES.Identifier) {
      return parent.left.name;
    }

    if (parent.left.type === AST_NODE_TYPES.MemberExpression) {
      return getReceiverKey(parent.left);
    }
  }

  return null;
}

export function isNewWorker(
  node: TSESTree.Node,
  imports: BullmqImports
): node is TSESTree.NewExpression {
  if (node.type !== AST_NODE_TYPES.NewExpression) {
    return false;
  }

  if (node.callee.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  return imports.workerLocalNames.has(node.callee.name);
}

export function isQueueAddCall(node: TSESTree.CallExpression): boolean {
  return (
    node.callee.type === AST_NODE_TYPES.MemberExpression &&
    node.callee.property.type === AST_NODE_TYPES.Identifier &&
    node.callee.property.name === "add"
  );
}

export function getCallReceiverKey(
  node: TSESTree.CallExpression
): string | null {
  return getReceiverKey(node.callee);
}

export function getReceiverKey(callee: TSESTree.Node): string | null {
  if (callee.type === AST_NODE_TYPES.MemberExpression) {
    if (callee.object.type === AST_NODE_TYPES.Identifier) {
      return callee.object.name;
    }

    if (
      callee.object.type === AST_NODE_TYPES.MemberExpression &&
      callee.object.property.type === AST_NODE_TYPES.Identifier
    ) {
      const base = getReceiverKey(callee.object);

      if (base) {
        return `${base}.${callee.object.property.name}`;
      }
    }
  }

  return null;
}

export function isQueueLikeReceiverName(name: string): boolean {
  return /[Qq]ueue/.test(name);
}

export function getOptionsObjectArg(
  node: TSESTree.NewExpression | TSESTree.CallExpression,
  argIndex: number
): TSESTree.ObjectExpression | null {
  const arg = node.arguments[argIndex];

  if (arg?.type === AST_NODE_TYPES.ObjectExpression) {
    return arg;
  }

  return null;
}

export function findObjectProperty(
  obj: TSESTree.ObjectExpression,
  name: string
): TSESTree.Property | null {
  for (const prop of obj.properties) {
    if (prop.type !== AST_NODE_TYPES.Property) {
      continue;
    }

    if (prop.key.type === AST_NODE_TYPES.Identifier && prop.key.name === name) {
      return prop;
    }

    if (prop.key.type === AST_NODE_TYPES.Literal && prop.key.value === name) {
      return prop;
    }
  }

  return null;
}
