import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { walkAll } from "../utils";

export { walkAll };

export const PHASER_PACKAGE = "phaser";

export const HOT_PATH_NAMES = new Set(["update", "tick", "preUpdate"]);

export const SCENE_PLUGIN_METHODS = new Set([
  "start",
  "launch",
  "stop",
  "pause",
  "resume",
  "sleep",
  "wake",
  "switch",
  "run",
  "restart",
  "remove",
]);

export const ADD_FACTORIES = new Set([
  "image",
  "sprite",
  "text",
  "graphics",
  "rectangle",
  "circle",
  "ellipse",
  "container",
  "zone",
  "tileSprite",
  "blitter",
  "nineslice",
  "dynamicBitmapText",
  "bitmapText",
  "renderTexture",
  "shader",
  "video",
  "particleEmitter",
  "particles",
  "rope",
  "layer",
  "arc",
  "polygon",
  "star",
  "triangle",
  "line",
  "curve",
]);

export const PHYSICS_ADD_CTORS = new Set([
  "sprite",
  "image",
  "existing",
  "group",
  "staticGroup",
]);

export const PHYSICS_COLLIDER_METHODS = new Set([
  "overlap",
  "collider",
  "colliderGroup",
]);

export const WORLD_COLLIDER_METHODS = new Set(["addCollider", "addOverlap"]);

export const TEXTURE_LOAD_METHODS = new Set([
  "image",
  "spritesheet",
  "atlas",
  "audio",
  "tilemapTiledJSON",
  "bitmapFont",
]);

export const TEXTURE_ADD_METHODS = new Set([
  "image",
  "sprite",
  "tileSprite",
  "nineslice",
]);

export const TEXTURE_MANAGER_METHODS = new Set(["get", "exists", "remove"]);

export const SOUND_KEY_METHODS = new Set(["add", "play"]);

export const PHASER_ALLOC_NAMESPACES = new Set([
  "Math",
  "Geom",
  "GameObjects",
  "Sound",
]);

export const GLOBAL_TIMER_CALLEES = new Set([
  "setInterval",
  "setTimeout",
  "requestAnimationFrame",
]);

export const DOM_GLOBALS = new Set(["window", "document", "globalThis"]);

const LISTENER_METHODS = new Set(["on", "addListener", "addEventListener"]);

export interface IPhaserImports {
  readonly hasPhaserImport: boolean;
  readonly namespaceNames: ReadonlySet<string>;
  readonly namedBindings: ReadonlyMap<string, string>;
}

export function isPhaserPackageSource(source: string): boolean {
  return source === PHASER_PACKAGE || source.startsWith(`${PHASER_PACKAGE}/`);
}

export function analyzePhaserImports(
  program: TSESTree.Program
): IPhaserImports {
  const namespaceNames = new Set<string>();
  const namedBindings = new Map<string, string>();
  let hasPhaserImport = false;

  for (const stmt of program.body) {
    if (stmt.type !== AST_NODE_TYPES.ImportDeclaration) {
      continue;
    }

    if (typeof stmt.source.value !== "string") {
      continue;
    }

    if (!isPhaserPackageSource(stmt.source.value)) {
      continue;
    }

    hasPhaserImport = true;
    recordPhaserSpecifiers(stmt, namespaceNames, namedBindings);
  }

  return { hasPhaserImport, namespaceNames, namedBindings };
}

function recordPhaserSpecifiers(
  stmt: TSESTree.ImportDeclaration,
  namespaceNames: Set<string>,
  namedBindings: Map<string, string>
): void {
  if (stmt.importKind === "type") {
    return;
  }

  for (const specifier of stmt.specifiers) {
    if (
      specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier ||
      specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier
    ) {
      namespaceNames.add(specifier.local.name);
      continue;
    }

    if (specifier.type !== AST_NODE_TYPES.ImportSpecifier) {
      continue;
    }

    if (specifier.importKind === "type") {
      continue;
    }

    if (specifier.imported.type !== AST_NODE_TYPES.Identifier) {
      continue;
    }

    namedBindings.set(specifier.local.name, specifier.imported.name);
  }
}

export function memberChain(node: TSESTree.Node): readonly string[] {
  const parts: string[] = [];
  let current: TSESTree.Node | undefined = node;

  while (current !== undefined) {
    if (current.type === AST_NODE_TYPES.MemberExpression) {
      if (current.computed) {
        break;
      }

      if (current.property.type !== AST_NODE_TYPES.Identifier) {
        break;
      }

      parts.unshift(current.property.name);
      current = current.object;
      continue;
    }

    if (current.type === AST_NODE_TYPES.Identifier) {
      parts.unshift(current.name);
      break;
    }

    if (current.type === AST_NODE_TYPES.ThisExpression) {
      parts.unshift("this");
      break;
    }

    if (current.type === AST_NODE_TYPES.Super) {
      parts.unshift("super");
      break;
    }

    break;
  }

  return parts;
}

export function chainEndsWith(
  chain: readonly string[],
  suffix: readonly string[]
): boolean {
  if (chain.length < suffix.length) {
    return false;
  }

  const offset = chain.length - suffix.length;

  for (let i = 0; i < suffix.length; i += 1) {
    if (chain[offset + i] !== suffix[i]) {
      return false;
    }
  }

  return true;
}

export function stringLiteralValue(
  node: TSESTree.Node | undefined
): string | null {
  if (node === undefined) {
    return null;
  }

  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return node.value;
  }

  return null;
}

export function isLiteralTrue(node: TSESTree.Node | undefined): boolean {
  return node?.type === AST_NODE_TYPES.Literal && node.value === true;
}

export function calleeName(node: TSESTree.CallExpression): string | null {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return node.callee.name;
  }

  const chain = memberChain(node.callee);
  const last = chain[chain.length - 1];

  return last ?? null;
}

export function isOnceCall(node: TSESTree.CallExpression): boolean {
  return calleeName(node) === "once";
}

export function isListenerMethod(name: string | null): boolean {
  return name !== null && LISTENER_METHODS.has(name);
}

export function isPhaserSceneClass(
  node: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
  imports: IPhaserImports
): boolean {
  if (node.superClass === null || node.superClass === undefined) {
    return false;
  }

  const chain = memberChain(node.superClass);

  if (chain.length === 2) {
    const ns = chain[0];
    const ident = chain[1];

    return (
      ns !== undefined && ident === "Scene" && imports.namespaceNames.has(ns)
    );
  }

  if (chain.length !== 1) {
    return false;
  }

  const name = chain[0];

  if (name === undefined) {
    return false;
  }

  return imports.namedBindings.get(name) === "Scene";
}

export function isShutdownEventArg(node: TSESTree.Node | undefined): boolean {
  if (node === undefined) {
    return false;
  }

  const literal = stringLiteralValue(node);

  if (literal === "shutdown" || literal === "destroy") {
    return true;
  }

  const chain = memberChain(node);
  const last = chain[chain.length - 1];

  return last === "SHUTDOWN" || last === "DESTROY";
}

function isHotPathKey(key: TSESTree.Node): boolean {
  if (key.type === AST_NODE_TYPES.Identifier) {
    return HOT_PATH_NAMES.has(key.name);
  }

  if (key.type === AST_NODE_TYPES.Literal && typeof key.value === "string") {
    return HOT_PATH_NAMES.has(key.value);
  }

  return false;
}

function isFunctionLike(
  node: TSESTree.Node | null | undefined
): node is
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration {
  if (node === null || node === undefined) {
    return false;
  }

  return (
    node.type === AST_NODE_TYPES.FunctionExpression ||
    node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node.type === AST_NODE_TYPES.FunctionDeclaration
  );
}

function isHotPathBindingName(name: string | undefined): boolean {
  return name !== undefined && HOT_PATH_NAMES.has(name);
}

export function shouldEnterHotPath(node: TSESTree.Node): boolean {
  if (
    node.type === AST_NODE_TYPES.MethodDefinition ||
    node.type === AST_NODE_TYPES.PropertyDefinition ||
    node.type === AST_NODE_TYPES.Property
  ) {
    if (!isHotPathKey(node.key)) {
      return false;
    }

    if (node.type === AST_NODE_TYPES.MethodDefinition) {
      return true;
    }

    return isFunctionLike(node.value);
  }

  if (node.type === AST_NODE_TYPES.FunctionDeclaration) {
    return isHotPathBindingName(node.id?.name);
  }

  if (
    node.type !== AST_NODE_TYPES.FunctionExpression &&
    node.type !== AST_NODE_TYPES.ArrowFunctionExpression
  ) {
    return false;
  }

  const parent = node.parent;

  if (
    parent.type === AST_NODE_TYPES.MethodDefinition ||
    parent.type === AST_NODE_TYPES.PropertyDefinition ||
    parent.type === AST_NODE_TYPES.Property
  ) {
    return false;
  }

  if (
    parent.type === AST_NODE_TYPES.VariableDeclarator &&
    parent.id.type === AST_NODE_TYPES.Identifier
  ) {
    return isHotPathBindingName(parent.id.name);
  }

  if (
    parent.type === AST_NODE_TYPES.AssignmentExpression &&
    parent.left.type === AST_NODE_TYPES.Identifier
  ) {
    return isHotPathBindingName(parent.left.name);
  }

  return false;
}

export function createHotPathTracker(): {
  readonly isInHotPath: () => boolean;
  readonly enter: (node: TSESTree.Node) => void;
  readonly exit: (node: TSESTree.Node) => void;
} {
  let depth = 0;

  return {
    isInHotPath: () => depth > 0,
    enter: (node) => {
      if (shouldEnterHotPath(node)) {
        depth += 1;
      }
    },
    exit: (node) => {
      if (shouldEnterHotPath(node) && depth > 0) {
        depth -= 1;
      }
    },
  };
}

export function hotPathVisitors(hot: {
  readonly enter: (node: TSESTree.Node) => void;
  readonly exit: (node: TSESTree.Node) => void;
}): Record<string, (node: TSESTree.Node) => void> {
  return {
    MethodDefinition: hot.enter,
    "MethodDefinition:exit": hot.exit,
    PropertyDefinition: hot.enter,
    "PropertyDefinition:exit": hot.exit,
    Property: hot.enter,
    "Property:exit": hot.exit,
    FunctionDeclaration: hot.enter,
    "FunctionDeclaration:exit": hot.exit,
    FunctionExpression: hot.enter,
    "FunctionExpression:exit": hot.exit,
    ArrowFunctionExpression: hot.enter,
    "ArrowFunctionExpression:exit": hot.exit,
  };
}

export function isPhaserNamespacedNew(
  node: TSESTree.NewExpression,
  imports: IPhaserImports
): boolean {
  const chain = memberChain(node.callee);

  if (chain.length < 3) {
    return false;
  }

  const ns = chain[0];
  const bucket = chain[1];

  return (
    ns !== undefined &&
    bucket !== undefined &&
    imports.namespaceNames.has(ns) &&
    PHASER_ALLOC_NAMESPACES.has(bucket)
  );
}

export function isAddFactoryCall(chain: readonly string[]): boolean {
  const method = chain[chain.length - 1];
  const owner = chain[chain.length - 2];

  return (
    method !== undefined &&
    (owner === "add" || owner === "make") &&
    ADD_FACTORIES.has(method)
  );
}

export function isPhysicsAddCtorCall(chain: readonly string[]): boolean {
  const method = chain[chain.length - 1];

  return (
    method !== undefined &&
    PHYSICS_ADD_CTORS.has(method) &&
    chainEndsWith(chain.slice(0, -1), ["physics", "add"])
  );
}

export function isPhysicsColliderCall(chain: readonly string[]): boolean {
  const method = chain[chain.length - 1];

  if (method === undefined) {
    return false;
  }

  if (PHYSICS_COLLIDER_METHODS.has(method)) {
    return chainEndsWith(chain.slice(0, -1), ["physics", "add"]);
  }

  if (WORLD_COLLIDER_METHODS.has(method)) {
    return chainEndsWith(chain.slice(0, -1), ["physics", "world"]);
  }

  return false;
}

export function isLoaderCall(chain: readonly string[]): boolean {
  return chain.length >= 2 && chain[chain.length - 2] === "load";
}

export function isScenePluginCall(chain: readonly string[]): boolean {
  if (chain.length < 2) {
    return false;
  }

  const method = chain[chain.length - 1];
  const owner = chain[chain.length - 2];

  return (
    owner === "scene" &&
    method !== undefined &&
    SCENE_PLUGIN_METHODS.has(method)
  );
}

export function isTextureKeyCall(
  chain: readonly string[],
  args: readonly TSESTree.CallExpressionArgument[]
): TSESTree.CallExpressionArgument | null {
  const method = chain[chain.length - 1];
  const owner = chain[chain.length - 2];

  if (method === undefined || owner === undefined) {
    return null;
  }

  if (owner === "add" && TEXTURE_ADD_METHODS.has(method)) {
    const key = args[2];

    return key ?? null;
  }

  if (owner === "load" && TEXTURE_LOAD_METHODS.has(method)) {
    const key = args[0];

    return key ?? null;
  }

  if (owner === "textures" && TEXTURE_MANAGER_METHODS.has(method)) {
    const key = args[0];

    return key ?? null;
  }

  if (owner === "sound" && SOUND_KEY_METHODS.has(method)) {
    const key = args[0];

    return key ?? null;
  }

  return null;
}

export function isTextMutationCall(chain: readonly string[]): boolean {
  const method = chain[chain.length - 1];

  return method === "setText" || method === "setStyle";
}

export function isForbiddenGlobalListener(
  node: TSESTree.CallExpression
): boolean {
  if (node.callee.type === AST_NODE_TYPES.Identifier) {
    return GLOBAL_TIMER_CALLEES.has(node.callee.name);
  }

  if (isOnceCall(node)) {
    return false;
  }

  const name = calleeName(node);

  if (!isListenerMethod(name)) {
    return false;
  }

  const chain = memberChain(node.callee);
  const root = chain[0];

  if (root !== undefined && DOM_GLOBALS.has(root) && chain.length === 2) {
    return true;
  }

  if (chainEndsWith(chain, ["game", "events", "on"])) {
    return true;
  }

  if (chainEndsWith(chain, ["registry", "events", "on"])) {
    return true;
  }

  if (chainEndsWith(chain, ["scale", "on"])) {
    return true;
  }

  if (chainEndsWith(chain, ["anims", "on"])) {
    return true;
  }

  if (chainEndsWith(chain, ["textures", "on"])) {
    return true;
  }

  return false;
}

export function isRequireCall(
  node: TSESTree.CallExpression
): node is TSESTree.CallExpression & {
  arguments: [TSESTree.Literal, ...TSESTree.CallExpressionArgument[]];
} {
  if (node.callee.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }

  if (node.callee.name !== "require") {
    return false;
  }

  const first = node.arguments[0];

  return (
    first?.type === AST_NODE_TYPES.Literal && typeof first.value === "string"
  );
}

export function requireSource(node: TSESTree.CallExpression): string | null {
  if (!isRequireCall(node)) {
    return null;
  }

  const first = node.arguments[0];

  if (
    first.type !== AST_NODE_TYPES.Literal ||
    typeof first.value !== "string"
  ) {
    return null;
  }

  return first.value;
}

export function isImportedPhaserBinding(
  node: TSESTree.Identifier,
  imports: IPhaserImports
): boolean {
  return (
    imports.namespaceNames.has(node.name) ||
    imports.namedBindings.has(node.name)
  );
}

export function isNonValueIdentifier(node: TSESTree.Identifier): boolean {
  const parent = node.parent;

  if (
    parent.type === AST_NODE_TYPES.ImportSpecifier ||
    parent.type === AST_NODE_TYPES.ImportDefaultSpecifier ||
    parent.type === AST_NODE_TYPES.ImportNamespaceSpecifier ||
    parent.type === AST_NODE_TYPES.ExportSpecifier
  ) {
    return true;
  }

  if (
    parent.type === AST_NODE_TYPES.MemberExpression &&
    parent.property === node
  ) {
    return true;
  }

  if (parent.type === AST_NODE_TYPES.TSQualifiedName) {
    return true;
  }

  if (parent.type === AST_NODE_TYPES.TSTypeReference) {
    return true;
  }

  if (parent.type === AST_NODE_TYPES.TSTypeQuery) {
    return true;
  }

  if (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.id === node) {
    return true;
  }

  if (
    parent.type === AST_NODE_TYPES.FunctionDeclaration &&
    parent.id === node
  ) {
    return true;
  }

  if (parent.type === AST_NODE_TYPES.ClassDeclaration && parent.id === node) {
    return true;
  }

  return false;
}

export function classBindsPersistentListeners(
  cls: TSESTree.ClassDeclaration | TSESTree.ClassExpression
): { readonly binds: boolean; readonly hasShutdownHook: boolean } {
  let binds = false;
  let hasShutdownHook = false;

  walkAll(cls, (node) => {
    if (node.type !== AST_NODE_TYPES.CallExpression) {
      return;
    }

    if (isShutdownEventArg(node.arguments[0]) && isLifecycleSubscribe(node)) {
      hasShutdownHook = true;

      return;
    }

    if (isOnceCall(node)) {
      return;
    }

    if (isListenerMethod(calleeName(node))) {
      binds = true;
    }
  });

  return { binds, hasShutdownHook };
}

function isLifecycleSubscribe(node: TSESTree.CallExpression): boolean {
  const name = calleeName(node);

  return name === "once" || name === "on" || name === "addListener";
}
