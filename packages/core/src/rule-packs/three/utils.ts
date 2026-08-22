import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { walkAll } from "../utils";

export { walkAll, walkSome } from "../utils";

const EXAMPLES_JSM_PREFIX = "three/examples/jsm/";
const ADDONS_PREFIX = "three/addons/";

const MATH_CTORS = new Set([
  "Box2",
  "Box3",
  "Color",
  "Cylindrical",
  "Euler",
  "Frustum",
  "Line3",
  "Matrix3",
  "Matrix4",
  "Plane",
  "Quaternion",
  "Ray",
  "Sphere",
  "Spherical",
  "Triangle",
  "Vector2",
  "Vector3",
  "Vector4",
]);

const CAMERA_CTORS = new Set([
  "ArrayCamera",
  "Camera",
  "CubeCamera",
  "OrthographicCamera",
  "PerspectiveCamera",
  "StereoCamera",
]);

const INSTANCED_MESH_CTORS = new Set(["InstancedMesh"]);

export interface IThreeImports {
  hasThreeImport: boolean;
  namespaceNames: Set<string>;
  namedBindings: Map<string, string>;
}

export function isThreePackageSource(source: string): boolean {
  return source === "three" || source.startsWith("three/");
}

export function isLegacyExamplesJsmSource(source: string): boolean {
  return source.startsWith(EXAMPLES_JSM_PREFIX);
}

export function isThreeSrcSource(source: string): boolean {
  return source.startsWith("three/src/") || source.startsWith("three/build/");
}

export function isThreeCdnSource(source: string): boolean {
  const lower = source.toLowerCase();

  if (
    !lower.startsWith("http://") &&
    !lower.startsWith("https://") &&
    !lower.startsWith("//")
  ) {
    return false;
  }

  return lower.includes("three");
}

export function rewriteExamplesJsmToAddons(source: string): string | null {
  if (!isLegacyExamplesJsmSource(source)) {
    return null;
  }

  return `${ADDONS_PREFIX}${source.slice(EXAMPLES_JSM_PREFIX.length)}`;
}

export function analyzeThreeImports(program: TSESTree.Program): IThreeImports {
  const result: IThreeImports = {
    hasThreeImport: false,
    namespaceNames: new Set(),
    namedBindings: new Map(),
  };

  for (const stmt of program.body) {
    if (stmt.type !== AST_NODE_TYPES.ImportDeclaration) {
      continue;
    }

    if (typeof stmt.source.value !== "string") {
      continue;
    }

    if (!isThreePackageSource(stmt.source.value)) {
      continue;
    }

    result.hasThreeImport = true;
    recordSpecifiers(stmt, result);
  }

  return result;
}

function recordSpecifiers(
  stmt: TSESTree.ImportDeclaration,
  result: IThreeImports
): void {
  for (const specifier of stmt.specifiers) {
    if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
      result.namespaceNames.add(specifier.local.name);
      continue;
    }

    if (specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier) {
      result.namespaceNames.add(specifier.local.name);
      continue;
    }

    if (specifier.type !== AST_NODE_TYPES.ImportSpecifier) {
      continue;
    }

    if (specifier.imported.type !== AST_NODE_TYPES.Identifier) {
      continue;
    }

    result.namedBindings.set(specifier.local.name, specifier.imported.name);
  }
}

export function getThreeImportedName(
  node: TSESTree.Node,
  imports: IThreeImports
): string | null {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return imports.namedBindings.get(node.name) ?? null;
  }

  if (node.type !== AST_NODE_TYPES.MemberExpression || node.computed) {
    return null;
  }

  if (node.object.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  if (!imports.namespaceNames.has(node.object.name)) {
    return null;
  }

  if (node.property.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  return node.property.name;
}

export function isThreeNewExpression(
  node: TSESTree.Node,
  imports: IThreeImports
): node is TSESTree.NewExpression {
  if (node.type !== AST_NODE_TYPES.NewExpression) {
    return false;
  }

  return getThreeImportedName(node.callee, imports) !== null;
}

export function isMathCtor(importedName: string): boolean {
  return MATH_CTORS.has(importedName);
}

export function isCameraCtor(importedName: string): boolean {
  return CAMERA_CTORS.has(importedName);
}

export function isInstancedMeshCtor(importedName: string): boolean {
  return INSTANCED_MESH_CTORS.has(importedName);
}

export function isLoaderCtor(importedName: string): boolean {
  return importedName.endsWith("Loader");
}

export function isGpuResourceCtor(importedName: string): boolean {
  if (importedName === "DRACOLoader" || importedName === "KTX2Loader") {
    return true;
  }

  return (
    importedName.endsWith("Geometry") ||
    importedName.endsWith("Material") ||
    importedName.endsWith("Texture") ||
    importedName.endsWith("Renderer") ||
    importedName.endsWith("RenderTarget")
  );
}

export function isObject3DCtor(importedName: string): boolean {
  if (isMathCtor(importedName)) {
    return false;
  }

  if (isLoaderCtor(importedName)) {
    return false;
  }

  if (isGpuResourceCtor(importedName)) {
    return false;
  }

  return true;
}

export function receiverKey(node: TSESTree.Node): string | null {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return node.name;
  }

  if (node.type === AST_NODE_TYPES.ThisExpression) {
    return "this";
  }

  if (node.type !== AST_NODE_TYPES.MemberExpression || node.computed) {
    return null;
  }

  const objectKey = receiverKey(node.object);

  if (objectKey === null) {
    return null;
  }

  if (node.property.type === AST_NODE_TYPES.Identifier) {
    return `${objectKey}.${node.property.name}`;
  }

  if (node.property.type === AST_NODE_TYPES.PrivateIdentifier) {
    return `${objectKey}.#${node.property.name}`;
  }

  return null;
}

export function memberPropertyName(
  node: TSESTree.MemberExpression
): string | null {
  if (node.computed) {
    return null;
  }

  if (node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }

  return null;
}

export function findEnclosingFunction(
  node: TSESTree.Node
):
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression
  | null {
  for (let current = node.parent; current; current = current.parent) {
    if (
      current.type === AST_NODE_TYPES.FunctionDeclaration ||
      current.type === AST_NODE_TYPES.FunctionExpression ||
      current.type === AST_NODE_TYPES.ArrowFunctionExpression
    ) {
      return current;
    }
  }

  return null;
}

export function findEnclosingClass(
  node: TSESTree.Node
): TSESTree.ClassDeclaration | TSESTree.ClassExpression | null {
  for (let current = node.parent; current; current = current.parent) {
    if (
      current.type === AST_NODE_TYPES.ClassDeclaration ||
      current.type === AST_NODE_TYPES.ClassExpression
    ) {
      return current;
    }
  }

  return null;
}

export function findEnclosingLoop(
  node: TSESTree.Node
):
  | TSESTree.ForStatement
  | TSESTree.ForInStatement
  | TSESTree.ForOfStatement
  | TSESTree.WhileStatement
  | TSESTree.DoWhileStatement
  | null {
  for (let current = node.parent; current; current = current.parent) {
    if (
      current.type === AST_NODE_TYPES.ForStatement ||
      current.type === AST_NODE_TYPES.ForInStatement ||
      current.type === AST_NODE_TYPES.ForOfStatement ||
      current.type === AST_NODE_TYPES.WhileStatement ||
      current.type === AST_NODE_TYPES.DoWhileStatement
    ) {
      return current;
    }

    if (
      current.type === AST_NODE_TYPES.FunctionDeclaration ||
      current.type === AST_NODE_TYPES.FunctionExpression ||
      current.type === AST_NODE_TYPES.ArrowFunctionExpression
    ) {
      return null;
    }
  }

  return null;
}

export function collectCtorBindingKeys(
  root: TSESTree.Node,
  imports: IThreeImports,
  isCtor: (importedName: string) => boolean
): Set<string> {
  const keys = new Set<string>();

  walkAll(root, (node) => {
    addCtorBinding(node, imports, isCtor, keys);
  });

  return keys;
}

function addCtorBinding(
  node: TSESTree.Node,
  imports: IThreeImports,
  isCtor: (importedName: string) => boolean,
  keys: Set<string>
): void {
  if (
    node.type === AST_NODE_TYPES.VariableDeclarator &&
    node.id.type === AST_NODE_TYPES.Identifier &&
    node.init &&
    isMatchingNew(node.init, imports, isCtor)
  ) {
    keys.add(node.id.name);

    return;
  }

  if (node.type === AST_NODE_TYPES.PropertyDefinition && node.value) {
    if (!isMatchingNew(node.value, imports, isCtor)) {
      return;
    }

    const fieldKey = propertyDefinitionKey(node);

    if (fieldKey !== null) {
      keys.add(fieldKey);
    }

    return;
  }

  if (node.type !== AST_NODE_TYPES.AssignmentExpression) {
    return;
  }

  if (!isMatchingNew(node.right, imports, isCtor)) {
    return;
  }

  const assigned = receiverKey(node.left);

  if (assigned !== null) {
    keys.add(assigned);
  }
}

function isMatchingNew(
  node: TSESTree.Node,
  imports: IThreeImports,
  isCtor: (importedName: string) => boolean
): boolean {
  if (!isThreeNewExpression(node, imports)) {
    return false;
  }

  const importedName = getThreeImportedName(node.callee, imports);

  return importedName !== null && isCtor(importedName);
}

function propertyDefinitionKey(
  node: TSESTree.PropertyDefinition
): string | null {
  if (node.computed) {
    return null;
  }

  if (node.key.type === AST_NODE_TYPES.Identifier) {
    return `this.${node.key.name}`;
  }

  if (node.key.type === AST_NODE_TYPES.PrivateIdentifier) {
    return `this.#${node.key.name}`;
  }

  if (
    node.key.type === AST_NODE_TYPES.Literal &&
    typeof node.key.value === "string"
  ) {
    return `this.${node.key.value}`;
  }

  return null;
}

export function collectModuleLevelCtorBindingKeys(
  program: TSESTree.Program,
  imports: IThreeImports,
  isCtor: (importedName: string) => boolean
): Set<string> {
  const keys = new Set<string>();

  for (const stmt of program.body) {
    const declaration = unwrapVariableDeclaration(stmt);

    if (!declaration) {
      continue;
    }

    for (const declarator of declaration.declarations) {
      addCtorBinding(declarator, imports, isCtor, keys);
    }
  }

  return keys;
}

function unwrapVariableDeclaration(
  stmt: TSESTree.Program["body"][number]
): TSESTree.VariableDeclaration | null {
  if (stmt.type === AST_NODE_TYPES.VariableDeclaration) {
    return stmt;
  }

  if (
    stmt.type === AST_NODE_TYPES.ExportNamedDeclaration &&
    stmt.declaration?.type === AST_NODE_TYPES.VariableDeclaration
  ) {
    return stmt.declaration;
  }

  return null;
}

export function annotatedParamNames(
  fn:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
  imports: IThreeImports,
  isCtor: (importedName: string) => boolean
): Set<string> {
  const names = new Set<string>();

  for (const param of fn.params) {
    if (param.type !== AST_NODE_TYPES.Identifier) {
      continue;
    }

    const typeName = typeAnnotationImportedName(param, imports);

    if (typeName !== null && isCtor(typeName)) {
      names.add(param.name);
    }
  }

  return names;
}

function typeAnnotationImportedName(
  param: TSESTree.Identifier,
  imports: IThreeImports
): string | null {
  const annotation = param.typeAnnotation?.typeAnnotation;

  if (annotation?.type !== AST_NODE_TYPES.TSTypeReference) {
    return null;
  }

  const typeName = annotation.typeName;

  if (typeName.type === AST_NODE_TYPES.Identifier) {
    return imports.namedBindings.get(typeName.name) ?? typeName.name;
  }

  if (typeName.type !== AST_NODE_TYPES.TSQualifiedName) {
    return null;
  }

  if (typeName.left.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  if (!imports.namespaceNames.has(typeName.left.name)) {
    return null;
  }

  if (typeName.right.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }

  return typeName.right.name;
}

export function resolveBindingKeys(
  node: TSESTree.Node,
  program: TSESTree.Program,
  imports: IThreeImports,
  isCtor: (importedName: string) => boolean
): Set<string> {
  const keys = collectModuleLevelCtorBindingKeys(program, imports, isCtor);
  const fn = findEnclosingFunction(node);

  if (fn) {
    for (const key of collectCtorBindingKeys(fn, imports, isCtor)) {
      keys.add(key);
    }

    for (const name of annotatedParamNames(fn, imports, isCtor)) {
      keys.add(name);
    }
  }

  const cls = findEnclosingClass(node);

  if (cls) {
    for (const key of collectCtorBindingKeys(cls, imports, isCtor)) {
      keys.add(key);
    }
  }

  return keys;
}

export function functionContainsCall(
  scope: TSESTree.Node,
  receiver: string,
  methodName: string
): boolean {
  return functionContainsMatchingCall(scope, receiver, methodName);
}

function functionContainsMatchingCall(
  scope: TSESTree.Node,
  receiver: string,
  methodName: string
): boolean {
  let found = false;

  walkAll(scope, (node) => {
    if (found) {
      return;
    }

    if (node.type !== AST_NODE_TYPES.CallExpression) {
      return;
    }

    if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
      return;
    }

    if (memberPropertyName(node.callee) !== methodName) {
      return;
    }

    if (receiverKey(node.callee.object) === receiver) {
      found = true;
    }
  });

  return found;
}

export function functionContainsNeedsUpdate(
  scope: TSESTree.Node,
  receiver: string,
  bufferName: "instanceMatrix" | "instanceColor"
): boolean {
  let found = false;

  walkAll(scope, (node) => {
    if (found) {
      return;
    }

    if (node.type !== AST_NODE_TYPES.AssignmentExpression) {
      return;
    }

    if (node.left.type !== AST_NODE_TYPES.MemberExpression) {
      return;
    }

    if (memberPropertyName(node.left) !== "needsUpdate") {
      return;
    }

    if (node.left.object.type !== AST_NODE_TYPES.MemberExpression) {
      return;
    }

    if (memberPropertyName(node.left.object) !== bufferName) {
      return;
    }

    if (receiverKey(node.left.object.object) === receiver) {
      found = true;
    }
  });

  return found;
}

export interface INamespaceUsage {
  importNode: TSESTree.ImportDeclaration;
  localName: string;
  members: Set<string>;
  escaped: boolean;
}

export function analyzeNamespaceImport(
  program: TSESTree.Program,
  importNode: TSESTree.ImportDeclaration,
  localName: string
): INamespaceUsage {
  const members = new Set<string>();
  let escaped = false;

  walkAll(program, (node) => {
    if (node.type !== AST_NODE_TYPES.Identifier || node.name !== localName) {
      return;
    }

    if (isNamespaceImportLocal(node, importNode)) {
      return;
    }

    const usage = classifyNamespaceUsage(node);

    if (usage === "member") {
      const parent = node.parent;

      if (
        parent.type === AST_NODE_TYPES.MemberExpression &&
        parent.property.type === AST_NODE_TYPES.Identifier
      ) {
        members.add(parent.property.name);
      }

      if (
        parent.type === AST_NODE_TYPES.TSQualifiedName &&
        parent.right.type === AST_NODE_TYPES.Identifier
      ) {
        members.add(parent.right.name);
      }

      return;
    }

    escaped = true;
  });

  return { importNode, localName, members, escaped };
}

function isNamespaceImportLocal(
  node: TSESTree.Identifier,
  importNode: TSESTree.ImportDeclaration
): boolean {
  const parent = node.parent;

  if (
    parent.type === AST_NODE_TYPES.ImportNamespaceSpecifier ||
    parent.type === AST_NODE_TYPES.ImportDefaultSpecifier
  ) {
    return parent.parent === importNode;
  }

  return false;
}

function classifyNamespaceUsage(
  node: TSESTree.Identifier
): "member" | "escape" {
  const parent = node.parent;

  if (
    parent.type === AST_NODE_TYPES.MemberExpression &&
    parent.object === node &&
    !parent.computed &&
    parent.property.type === AST_NODE_TYPES.Identifier
  ) {
    return "member";
  }

  if (
    parent.type === AST_NODE_TYPES.TSQualifiedName &&
    parent.left === node &&
    parent.right.type === AST_NODE_TYPES.Identifier
  ) {
    return "member";
  }

  return "escape";
}

export function programDeclaresName(
  program: TSESTree.Program,
  name: string
): boolean {
  let declared = false;

  walkAll(program, (node) => {
    if (declared) {
      return;
    }

    if (
      node.type === AST_NODE_TYPES.VariableDeclarator &&
      node.id.type === AST_NODE_TYPES.Identifier &&
      node.id.name === name
    ) {
      declared = true;

      return;
    }

    if (
      node.type === AST_NODE_TYPES.FunctionDeclaration &&
      node.id?.name === name
    ) {
      declared = true;

      return;
    }

    if (
      node.type === AST_NODE_TYPES.ClassDeclaration &&
      node.id?.name === name
    ) {
      declared = true;

      return;
    }

    if (
      node.type === AST_NODE_TYPES.ImportSpecifier &&
      node.local.name === name
    ) {
      declared = true;
    }
  });

  return declared;
}

export function hasAdditionalThreeValueImport(
  program: TSESTree.Program,
  namespaceImport: TSESTree.ImportDeclaration
): boolean {
  for (const stmt of program.body) {
    if (stmt.type !== AST_NODE_TYPES.ImportDeclaration) {
      continue;
    }

    if (stmt === namespaceImport) {
      continue;
    }

    if (stmt.importKind === "type") {
      continue;
    }

    if (stmt.source.value !== "three") {
      continue;
    }

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

export function childrenObject(
  node: TSESTree.MemberExpression
): TSESTree.Expression | null {
  if (memberPropertyName(node) !== "children") {
    return null;
  }

  return node.object;
}
