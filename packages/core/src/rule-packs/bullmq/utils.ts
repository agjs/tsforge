import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

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
      if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
        const importedName =
          specifier.imported.type === AST_NODE_TYPES.Identifier
            ? specifier.imported.name
            : null;
        const localName = specifier.local.name;

        if (importedName && importedName === "Worker") {
          result.workerLocalNames.add(localName);
        } else if (importedName && importedName === "Queue") {
          result.queueLocalNames.add(localName);
        } else if (importedName && importedName === "QueueEvents") {
          result.queueEventsLocalNames.add(localName);
        }
      }
    }
  }

  return result;
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
    if (node.type === AST_NODE_TYPES.VariableDeclarator) {
      if (
        node.id.type === AST_NODE_TYPES.Identifier &&
        node.init &&
        isNewQueue(node.init, imports)
      ) {
        const varName = node.id.name;
        const firstArg = node.init.arguments[0];

        if (firstArg && firstArg.type === AST_NODE_TYPES.Literal) {
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
    }
  });

  walkAll(program, (node) => {
    if (!isNewQueue(node, imports)) {
      return;
    }

    const firstArg = node.arguments[0];

    if (!firstArg || firstArg.type !== AST_NODE_TYPES.Literal) {
      return;
    }

    const queueName = firstArg.value;

    if (typeof queueName !== "string") {
      return;
    }

    const defaultJobOptions = extractDefaultJobOptions(node);
    const parent = (node as any).parent;

    if (
      !parent ||
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
    if (node.type === AST_NODE_TYPES.VariableDeclarator) {
      if (
        node.id.type === AST_NODE_TYPES.Identifier &&
        node.init &&
        isNewWorker(node.init, imports)
      ) {
        varToWorkerMap.set(node.id.name, node.init);
      }
    }
  });

  walkAll(program, (node) => {
    if (!isNewWorker(node, imports)) {
      return;
    }

    const parent = (node as any).parent;
    let bindingKey: string | null = null;

    if (parent) {
      if (
        parent.type === AST_NODE_TYPES.VariableDeclarator &&
        parent.id.type === AST_NODE_TYPES.Identifier
      ) {
        bindingKey = parent.id.name;
      } else if (parent.type === AST_NODE_TYPES.PropertyDefinition) {
        if (parent.key.type === AST_NODE_TYPES.Identifier && !parent.computed) {
          bindingKey = `this.${parent.key.name}`;
        } else if (
          parent.key.type === AST_NODE_TYPES.Literal &&
          typeof parent.key.value === "string"
        ) {
          bindingKey = `this.${parent.key.value}`;
        }
      } else if (parent.type === AST_NODE_TYPES.AssignmentExpression) {
        const left = parent.left;
        if (left.type === AST_NODE_TYPES.Identifier) {
          bindingKey = left.name;
        } else if (left.type === AST_NODE_TYPES.MemberExpression) {
          bindingKey = getReceiverKey(left);
        }
      }
    }

    workers.push({
      bindingKey,
      node,
    });
  });

  return workers;
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

  if (arg && arg.type === AST_NODE_TYPES.ObjectExpression) {
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

const NON_NODE_KEYS = new Set([
  "parent",
  "loc",
  "range",
  "tokens",
  "comments",
  "start",
  "end",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

export function walkAll(
  node: TSESTree.Node,
  callback: (node: TSESTree.Node) => void
): void {
  const visited = new WeakSet<object>();

  function walk(n: TSESTree.Node): void {
    if (visited.has(n)) {
      return;
    }

    visited.add(n);
    callback(n);

    for (const [key, value] of Object.entries(n)) {
      if (NON_NODE_KEYS.has(key)) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "object" && item !== null && "type" in item) {
            walk(item as TSESTree.Node);
          }
        }
      } else if (
        typeof value === "object" &&
        value !== null &&
        "type" in value
      ) {
        walk(value as TSESTree.Node);
      }
    }
  }

  walk(node);
}

export function walkSome(
  node: TSESTree.Node,
  predicate: (node: TSESTree.Node) => boolean
): boolean {
  const visited = new WeakSet<object>();

  function walk(n: TSESTree.Node): boolean {
    if (visited.has(n)) {
      return false;
    }

    visited.add(n);

    if (predicate(n)) {
      return true;
    }

    for (const [key, value] of Object.entries(n)) {
      if (NON_NODE_KEYS.has(key)) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "object" && item !== null && "type" in item) {
            if (walk(item as TSESTree.Node)) {
              return true;
            }
          }
        }
      } else if (
        typeof value === "object" &&
        value !== null &&
        "type" in value
      ) {
        if (walk(value as TSESTree.Node)) {
          return true;
        }
      }
    }

    return false;
  }

  return walk(node);
}
