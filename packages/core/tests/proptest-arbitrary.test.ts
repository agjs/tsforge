import { test, expect } from "bun:test";
import { arbitraryFor, type IArbType } from "../src/proptest/arbitrary";

test("primitives map to their fast-check arbitraries", () => {
  expect(arbitraryFor({ kind: "number" })).toBe("fc.double()");
  expect(arbitraryFor({ kind: "string" })).toBe("fc.string()");
  expect(arbitraryFor({ kind: "boolean" })).toBe("fc.boolean()");
  expect(arbitraryFor({ kind: "bigint" })).toBe("fc.bigInt()");
  expect(arbitraryFor({ kind: "unknown" })).toBe("fc.anything()");
});

test("array nests its element arbitrary", () => {
  expect(arbitraryFor({ kind: "array", elem: { kind: "string" } })).toBe(
    "fc.array(fc.string())"
  );
  expect(
    arbitraryFor({
      kind: "array",
      elem: { kind: "array", elem: { kind: "number" } },
    })
  ).toBe("fc.array(fc.array(fc.double()))");
});

test("tuple maps each position", () => {
  expect(
    arbitraryFor({
      kind: "tuple",
      items: [{ kind: "number" }, { kind: "string" }],
    })
  ).toBe("fc.tuple(fc.double(), fc.string())");
});

test("record maps fields with quoted keys", () => {
  const t: IArbType = {
    kind: "record",
    fields: [
      { name: "id", type: { kind: "number" } },
      { name: "label", type: { kind: "string" } },
    ],
  };

  expect(arbitraryFor(t)).toBe(
    'fc.record({ "id": fc.double(), "label": fc.string() })'
  );
});

test("option wraps with the right nil", () => {
  expect(
    arbitraryFor({
      kind: "option",
      inner: { kind: "number" },
      nil: "undefined",
    })
  ).toBe("fc.option(fc.double(), { nil: undefined })");
  expect(
    arbitraryFor({ kind: "option", inner: { kind: "string" }, nil: "null" })
  ).toBe("fc.option(fc.string(), { nil: null })");
});

test("union becomes fc.oneof", () => {
  expect(
    arbitraryFor({
      kind: "union",
      options: [{ kind: "number" }, { kind: "string" }],
    })
  ).toBe("fc.oneof(fc.double(), fc.string())");
});

test("deeply composed shape renders correctly", () => {
  const t: IArbType = {
    kind: "array",
    elem: {
      kind: "record",
      fields: [
        { name: "tags", type: { kind: "array", elem: { kind: "string" } } },
        {
          name: "score",
          type: { kind: "option", inner: { kind: "number" }, nil: "undefined" },
        },
      ],
    },
  };

  expect(arbitraryFor(t)).toBe(
    'fc.array(fc.record({ "tags": fc.array(fc.string()), "score": fc.option(fc.double(), { nil: undefined }) }))'
  );
});
