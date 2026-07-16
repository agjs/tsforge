import { test, expect } from "bun:test";
import { idiomHints } from "../src/loop/feedback/rule-docs";
import type { ErrorSet } from "../src/validate";

const UNSAFE_ERR: ErrorSet = [
  {
    key: "money.ts:30:@typescript-eslint/no-unsafe-assignment",
    file: "money.ts",
    line: 30,
    rule: "@typescript-eslint/no-unsafe-assignment",
    message: "Unsafe assignment of an `any` value.",
  },
];

test("flags `new Array(n).fill()` when an unsafe/any error is present", () => {
  const src = "const result = new Array(ratios.length).fill(base);\n";
  const hint = idiomHints([src], UNSAFE_ERR);

  expect(hint).toContain("Array.from({ length: n }, () => x)");
});

test("does NOT fire when the source has no `new Array().fill()` (no false hint)", () => {
  const src = "const result = ratios.map(() => 0);\n";

  expect(idiomHints([src], UNSAFE_ERR)).toBe("");
});

test("explains the opaque Elysia InlineHandler TS2345 as a nullable-response mismatch", () => {
  const src =
    "export const XResponse = t.Object({ notes: t.Optional(t.String()) });\n";
  const err: ErrorSet = [
    {
      key: "x.routes.ts:16:TS2345",
      file: "x.routes.ts",
      line: 16,
      rule: "TS2345",
      message:
        "Argument of type '(...) => Promise<...>' is not assignable to parameter of type 'InlineHandlerNonMacro<...>'.",
    },
  ];

  const hint = idiomHints([src], err);

  expect(hint).toContain("t.Optional(t.Union([t.String(), t.Null()]))");
  expect(hint).toContain("NOT a routing/`.group()` problem");
});

test("does NOT fire when errors are unrelated, even if the pattern is present", () => {
  // `new Array().fill()` in source, but the only error is a possibly-undefined
  // index access — not this trap's signature, so stay silent.
  const src = "const result = new Array(n).fill(0);\n";
  const indexErr: ErrorSet = [
    {
      key: "money.ts:46:TS2532",
      file: "money.ts",
      line: 46,
      rule: "TS2532",
      message: "Object is possibly 'undefined'.",
    },
  ];

  expect(idiomHints([src], indexErr)).toBe("");
});
