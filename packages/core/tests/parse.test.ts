import { test, expect } from "bun:test";
import {
  parseTsc,
  genericErrors,
  parseEslintJson,
  combinedParser,
  parserFor,
  isEslintJsonLine,
  fallbackMessage,
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

test("genericErrors announces truncation past the cap", () => {
  const message = genericErrors("x".repeat(700))[0]?.message;

  expect(message?.startsWith("x".repeat(500))).toBe(true);
  expect(message).toContain("… (output truncated)");
  expect(message?.length).toBeLessThan(550);
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

test("parseEslintJson extracts the JSON line from mixed web-gate output", () => {
  // The web gate is `bun run build && tsc && eslint --format json && …`, so the
  // captured output is vite build TEXT with eslint's single JSON line embedded.
  // `JSON.parse` of the whole thing throws — the old parser returned [] and the
  // whole wall (incl. the raw JSON) dumped as one fallback blob. It must now
  // pull the located error out of the noise.
  const eslint = JSON.stringify([
    {
      filePath: "/r/src/views/Foo/index.tsx",
      messages: [
        {
          ruleId: "no-restricted-syntax",
          severity: 2,
          message: "No `as` type casts",
          line: 12,
          column: 5,
        },
      ],
    },
  ]);
  const out = [
    "vite v6.4.3 building for production...",
    "✓ 188 modules transformed.",
    "✓ built in 1.71s",
    eslint,
    "$ next step never reached",
  ].join("\n");
  const items = parseEslintJson(out);

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    file: "/r/src/views/Foo/index.tsx",
    line: 12,
    rule: "no-restricted-syntax",
  });
});

test("parseEslintJson unions two chained eslint runs (syntactic + type-aware)", () => {
  // The web gate runs eslint twice: `lint && type-aware`. When the first passes
  // it prints `[]`; the type-aware run prints the real errors. Taking the FIRST
  // array line would miss them — every JSON-array line must be unioned.
  const empty = JSON.stringify([]);
  const typeAware = JSON.stringify([
    {
      filePath: "/r/src/views/Foo/foo.hooks.ts",
      messages: [
        {
          ruleId: "@typescript-eslint/no-floating-promises",
          severity: 2,
          message: "Promises must be awaited.",
          line: 8,
          column: 3,
        },
      ],
    },
  ]);
  const out = ["✓ built in 1.71s", empty, typeAware].join("\n");
  const items = parseEslintJson(out);

  expect(items).toHaveLength(1);
  expect(items[0]!.rule).toBe("@typescript-eslint/no-floating-promises");
});

test("isEslintJsonLine flags the eslint blob, not ordinary output", () => {
  expect(
    isEslintJsonLine('[{"filePath":"/a.ts","messages":[],"errorCount":0}]')
  ).toBe(true);
  expect(isEslintJsonLine("✓ built in 1.71s")).toBe(false);
  expect(isEslintJsonLine("[vite] hmr update")).toBe(false);
  expect(isEslintJsonLine("[]")).toBe(false);
});

test("parserFor picks a parser by command", () => {
  expect(parserFor("eslint . --format json")).toBe(parseEslintJson);
  expect(parserFor("tsc --noEmit")).toBe(parseTsc);
  // bun test uses structured failure parsing (not the opaque generic blob).
  const bunItems = parserFor("bun test x")(
    "src/a.test.ts:\n(fail) a > breaks\n"
  );

  expect(bunItems[0]?.rule).toBe("bun-test");
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

test("fallbackMessage drops eslint's machine JSON line", () => {
  const eslintJson = `[{"filePath":"/r/a.ts","messages":[]}]`;
  const msg = fallbackMessage(`vite build failed: bad import\n${eslintJson}`);

  expect(msg).toBe("vite build failed: bad import");
  expect(msg).not.toContain('"filePath"');
});

test("fallbackMessage caps a wall of build output and marks the truncation", () => {
  const blob = "x".repeat(5000);
  const msg = fallbackMessage(blob);

  // capped to FALLBACK_CAP (1200) + the truncation marker, not the raw 5000.
  expect(msg.length).toBeLessThan(1300);
  expect(msg.startsWith("x".repeat(1200))).toBe(true);
  expect(msg).toContain("… (output truncated)");
});

test("fallbackMessage degrades to a fixed string when nothing human-readable remains", () => {
  const onlyJson = `[{"filePath":"/r/a.ts","messages":[]}]`;

  expect(fallbackMessage(onlyJson)).toBe("command exited non-zero");
  expect(fallbackMessage("   \n  ")).toBe("command exited non-zero");
});

test("parseTsc surfaces file-less diagnostics like TS18003 (config-level errors)", () => {
  const out = [
    "error TS18003: No inputs were found in config file '/repo/tsconfig.json'.",
    "src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  ].join("\n");
  const items = parseTsc(out);

  expect(items).toHaveLength(2);
  expect(items.some((e) => e.key === "tsc:TS18003")).toBe(true);
  expect(items.find((e) => e.key === "tsc:TS18003")?.message).toContain(
    "No inputs were found"
  );
});
