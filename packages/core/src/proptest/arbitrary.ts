/**
 * Pure type → fast-check arbitrary mapping. The TS-checker walk (impure) lives in
 * from-type.ts and lowers a `ts.Type` into the `IArbType` descriptor below; THIS
 * module turns that descriptor into a fast-check expression string. Kept pure (no
 * `typescript` import) so it is trivially unit-testable in isolation.
 */
export type IArbType =
  | { readonly kind: "number" }
  | { readonly kind: "string" }
  | { readonly kind: "boolean" }
  | { readonly kind: "bigint" }
  | { readonly kind: "unknown" }
  | { readonly kind: "array"; readonly elem: IArbType }
  | { readonly kind: "tuple"; readonly items: readonly IArbType[] }
  | {
      readonly kind: "record";
      readonly fields: readonly {
        readonly name: string;
        readonly type: IArbType;
      }[];
    }
  | {
      readonly kind: "option";
      readonly inner: IArbType;
      readonly nil: "undefined" | "null";
    }
  | { readonly kind: "union"; readonly options: readonly IArbType[] };

/**
 * A fast-check arbitrary expression for a descriptor. Total over `IArbType` — the
 * "is this type supported?" decision happens upstream in from-type.ts (which
 * returns null for shapes we can't model); here every descriptor maps to a string.
 * `number` uses `fc.double()` (NaN/±Infinity included) on purpose — those are the
 * inputs that surface unguarded math/coercion crashes.
 */
export function arbitraryFor(t: IArbType): string {
  switch (t.kind) {
    case "number":
      return "fc.double()";
    case "string":
      return "fc.string()";
    case "boolean":
      return "fc.boolean()";
    case "bigint":
      return "fc.bigInt()";
    case "unknown":
      return "fc.anything()";
    case "array":
      return `fc.array(${arbitraryFor(t.elem)})`;
    case "tuple":
      return `fc.tuple(${t.items.map(arbitraryFor).join(", ")})`;
    case "record":
      return `fc.record({ ${t.fields
        .map((f) => `${JSON.stringify(f.name)}: ${arbitraryFor(f.type)}`)
        .join(", ")} })`;
    case "option":
      return `fc.option(${arbitraryFor(t.inner)}, { nil: ${t.nil} })`;
    case "union":
      return `fc.oneof(${t.options.map(arbitraryFor).join(", ")})`;
  }
}
