import { test, expect } from "bun:test";
import {
  parseTsc,
  genericErrors,
  parseEslintJson,
  combinedParser,
  parserFor,
} from "../src/validate";

test("parseTsc extracts file/line/rule per diagnostic", () => {
  const out = [
    "src/a.ts(12,5): error TS2322: Type 'x' is not assignable.",
    "some noise line",
    "src/b.ts(3,1): error TS2304: Cannot find name 'y'.",
  ].join("\n");
  const items = parseTsc(out);

  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({
    file: "src/a.ts",
    line: 12,
    rule: "TS2322",
  });
  expect(items[0]!.key).toBe("src/a.ts:12:TS2322");
});

test("genericErrors: empty output → no errors, else one raw error", () => {
  expect(genericErrors("   ")).toEqual([]);
  expect(genericErrors("boom")).toHaveLength(1);
});

test("parseEslintJson extracts errors, including custom plugin rule ids", () => {
  const out = JSON.stringify([
    {
      filePath: "/r/a.ts",
      messages: [
        {
          ruleId: "@boring-stack/structured-logging",
          severity: 2,
          message: "missing event",
          line: 7,
          column: 3,
        },
        {
          ruleId: "no-console",
          severity: 1,
          message: "just a warning",
          line: 9,
          column: 1,
        },
      ],
    },
  ]);
  const items = parseEslintJson(out);

  expect(items).toHaveLength(1); // severity-2 only; warnings ignored
  expect(items[0]).toMatchObject({
    file: "/r/a.ts",
    line: 7,
    rule: "@boring-stack/structured-logging",
  });
  expect(items[0]!.key).toBe("/r/a.ts:7:@boring-stack/structured-logging");
});

test("parseEslintJson tolerates non-JSON output", () => {
  expect(parseEslintJson("not json at all")).toEqual([]);
});

test("parserFor picks a parser by command", () => {
  expect(parserFor("eslint . --format json")).toBe(parseEslintJson);
  expect(parserFor("tsc --noEmit")).toBe(parseTsc);
  expect(parserFor("bun test x")).toBe(genericErrors);
});

test("parserFor uses the combined parser for chained tsc && eslint gates", () => {
  // The money gate: `tsc -p … && eslint --format json … && bun test`.
  expect(parserFor("tsc -p tsconfig.json && eslint --format json a.ts")).toBe(
    combinedParser
  );
});

test("combinedParser structures tsc-text output (the tsc-fails phase)", () => {
  // When tsc fails, `&&` short-circuits: the output is tsc TEXT, not eslint JSON.
  // The old eslint-json parser returned [] here → the whole wall dumped as one
  // blob. combinedParser must yield located, per-error items.
  const out = [
    "money.ts(46,28): error TS2532: Object is possibly 'undefined'.",
    "money.ts(58,11): error TS2532: Object is possibly 'undefined'.",
  ].join("\n");
  const items = combinedParser(out);

  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({
    file: "money.ts",
    line: 46,
    rule: "TS2532",
  });
});

test("combinedParser structures eslint JSON output (the tsc-passes phase)", () => {
  const out = JSON.stringify([
    {
      filePath: "/r/money.ts",
      messages: [
        {
          ruleId: "@typescript-eslint/no-non-null-assertion",
          severity: 2,
          message: "Forbidden non-null assertion.",
          line: 58,
          column: 22,
        },
      ],
    },
  ]);
  const items = combinedParser(out);

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    file: "/r/money.ts",
    line: 58,
    rule: "@typescript-eslint/no-non-null-assertion",
  });
});
