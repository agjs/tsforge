import ts from "typescript";
import type { IArbType } from "./arbitrary";

/**
 * Lower a `ts.Type` into the `IArbType` descriptor arbitrary.ts understands, or
 * null when the type is something we won't model (functions, classes, Record
 * index signatures, recursion past the depth cap). Null propagates up — one
 * unsupported field/param makes the whole shape unsupported, so the oracle simply
 * skips that function rather than guessing.
 */
export function shapeOfType(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth = 0
): IArbType | null {
  if (depth > 4) {
    return null;
  }

  const prim = primitiveShape(type);

  if (prim !== null) {
    return prim;
  }

  if (type.isUnion()) {
    return unionShape(type, checker, depth);
  }

  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return null;
  }

  // Arrays carry a number index type AND the global Array/ReadonlyArray symbol
  // (a plain object has many properties too, so a property-count check would
  // mis-classify `number[]`). Tuples are intentionally NOT handled here.
  const name = type.getSymbol()?.name;
  const elem = checker.getIndexTypeOfType(type, ts.IndexKind.Number);

  if (elem !== undefined && (name === "Array" || name === "ReadonlyArray")) {
    const e = shapeOfType(elem, checker, depth + 1);

    return e === null ? null : { kind: "array", elem: e };
  }

  return objectShape(type, checker, depth);
}

/** Primitive flag → descriptor (number/string/boolean/bigint/unknown), else null. */
function primitiveShape(type: ts.Type): IArbType | null {
  const f = type.flags;

  if ((f & ts.TypeFlags.NumberLike) !== 0) {
    return { kind: "number" };
  }

  if ((f & ts.TypeFlags.StringLike) !== 0) {
    return { kind: "string" };
  }

  if ((f & ts.TypeFlags.BooleanLike) !== 0) {
    return { kind: "boolean" };
  }

  if ((f & ts.TypeFlags.BigIntLike) !== 0) {
    return { kind: "bigint" };
  }

  if ((f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return { kind: "unknown" };
  }

  return null;
}

const NIL_FLAGS =
  ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;

/** Union → option (T | undefined/null) or oneof; null if any member unsupported. */
function unionShape(
  type: ts.UnionType,
  checker: ts.TypeChecker,
  depth: number
): IArbType | null {
  const nonNil = type.types.filter((p) => (p.flags & NIL_FLAGS) === 0);
  const shapes: IArbType[] = [];

  for (const part of nonNil) {
    const s = shapeOfType(part, checker, depth + 1);

    if (s === null) {
      return null;
    }

    shapes.push(s);
  }

  if (shapes.length === 0) {
    return null;
  }

  const inner: IArbType =
    shapes.length === 1 && shapes[0] !== undefined
      ? shapes[0]
      : { kind: "union", options: shapes };
  const hasNull = type.types.some((p) => (p.flags & ts.TypeFlags.Null) !== 0);
  const hasUndef = type.types.some(
    (p) => (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0
  );

  if (hasUndef) {
    return { kind: "option", inner, nil: "undefined" };
  }

  if (hasNull) {
    return { kind: "option", inner, nil: "null" };
  }

  return inner;
}

/** Named-property object → record; null if any field is unsupported (e.g. a
 *  method) or the object is opaque/empty. */
function objectShape(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number
): IArbType | null {
  const props = type.getProperties();

  if (props.length === 0) {
    return null;
  }

  const fields: { name: string; type: IArbType }[] = [];

  for (const prop of props) {
    const pt = checker.getTypeOfSymbol(prop);
    const s = shapeOfType(pt, checker, depth + 1);

    if (s === null) {
      return null;
    }

    fields.push({ name: prop.name, type: s });
  }

  return { kind: "record", fields };
}
