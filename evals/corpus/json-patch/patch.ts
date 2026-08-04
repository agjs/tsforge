import { parsePointer } from "./pointer";

export class PatchError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = "PatchError";
    this.path = path;
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface IOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

function isObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }

  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);

    return (
      ka.length === kb.length &&
      ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
    );
  }

  return false;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Walk to the parent of the final segment. */
function parentOf(
  doc: unknown,
  segments: readonly string[],
  path: string
): unknown {
  let node: unknown = doc;

  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(node)) {
      const index = Number(segment);

      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        throw new PatchError(`no such index: ${segment}`, path);
      }

      node = node[index];
      continue;
    }

    if (!isObject(node) || !Object.hasOwn(node, segment)) {
      throw new PatchError(`no such key: ${segment}`, path);
    }

    node = node[segment];
  }

  return node;
}

function readAt(doc: unknown, path: string): unknown {
  const segments = parsePointer(path);

  if (segments.length === 0) {
    return doc;
  }

  const parent = parentOf(doc, segments, path);
  const last = segments[segments.length - 1] ?? "";

  if (Array.isArray(parent)) {
    const index = Number(last);

    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw new PatchError(`no such index: ${last}`, path);
    }

    return parent[index];
  }

  if (!isObject(parent) || !Object.hasOwn(parent, last)) {
    throw new PatchError(`no such key: ${last}`, path);
  }

  return parent[last];
}

function insertAt(
  doc: unknown,
  path: string,
  value: unknown,
  replace: boolean
): void {
  const segments = parsePointer(path);
  const parent = parentOf(doc, segments, path);
  const last = segments[segments.length - 1] ?? "";

  if (Array.isArray(parent)) {
    if (last === "-") {
      parent.push(value);

      return;
    }

    const index = Number(last);
    const limit = replace ? parent.length - 1 : parent.length;

    if (!Number.isInteger(index) || index < 0 || index > limit) {
      throw new PatchError(`index out of range: ${last}`, path);
    }

    parent.splice(index, replace ? 1 : 0, value);

    return;
  }

  if (!isObject(parent)) {
    throw new PatchError("parent is not a container", path);
  }

  parent[last] = value as Json;
}

function removeAt(doc: unknown, path: string): void {
  const segments = parsePointer(path);
  const parent = parentOf(doc, segments, path);
  const last = segments[segments.length - 1] ?? "";

  if (Array.isArray(parent)) {
    const index = Number(last);

    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw new PatchError(`no such index: ${last}`, path);
    }

    parent.splice(index, 1);

    return;
  }

  if (!isObject(parent) || !Object.hasOwn(parent, last)) {
    throw new PatchError(`no such key: ${last}`, path);
  }

  Reflect.deleteProperty(parent, last);
}

/** True when `path` is `from` or sits inside it — moving there would detach the
 *  subtree into itself. */
function isInside(from: string, path: string): boolean {
  return path === from || path.startsWith(`${from}/`);
}

function applyOne(doc: unknown, op: IOp): void {
  switch (op.op) {
    case "add":
      insertAt(doc, op.path, op.value, false);

      return;

    case "replace":
      readAt(doc, op.path);
      insertAt(doc, op.path, op.value, true);

      return;

    case "remove":
      removeAt(doc, op.path);

      return;

    case "test":
      if (!deepEqual(readAt(doc, op.path), op.value)) {
        throw new PatchError("test failed", op.path);
      }

      return;

    case "move": {
      const from = op.from ?? "";

      if (isInside(from, op.path)) {
        throw new PatchError("cannot move a location into itself", op.path);
      }

      const value = readAt(doc, from);

      removeAt(doc, from);
      insertAt(doc, op.path, value, false);

      return;
    }

    case "copy":
      insertAt(doc, op.path, clone(readAt(doc, op.from ?? "")), false);

      return;

    default:
      throw new PatchError("unknown operation", op.path);
  }
}

/** Apply an RFC 6902 patch, returning a new document. All-or-nothing: the input
 *  is untouched, and a failed operation discards the whole patch. */
export function applyPatch<T>(doc: T, ops: readonly IOp[]): T {
  const draft = clone(doc);

  for (const op of ops) {
    if (op.path === "" && op.op !== "test") {
      throw new PatchError("cannot operate on the whole document", op.path);
    }

    applyOne(draft, op);
  }

  return draft;
}
