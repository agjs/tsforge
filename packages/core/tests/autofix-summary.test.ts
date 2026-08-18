import { test, expect } from "bun:test";
import {
  countChangedLines,
  buildAutoFixSummary,
  type IFixFileState,
  type IFixCounts,
} from "../src/loop/autofix-summary";

function snap(
  entries: Record<string, IFixFileState>
): Map<string, IFixFileState> {
  return new Map(Object.entries(entries));
}

const NO_COUNTS = new Map<string, IFixCounts>();

test("countChangedLines counts removed + added lines", () => {
  expect(countChangedLines("a\nb\nc\n", "a\nB\nc\n")).toBe(2); // b→B
  expect(countChangedLines("a\n", "a\nb\n")).toBe(1); // one added
  expect(countChangedLines("same\n", "same\n")).toBe(0);
});

test("a touched-but-identical file is NOT reported as auto-fixed", () => {
  const out = buildAutoFixSummary(
    snap({ "a.ts": { mtime: 1, text: "x\n" } }),
    snap({ "a.ts": { mtime: 2, text: "x\n" } }),
    NO_COUNTS,
    false
  );

  expect(out.files).toEqual([]);
});

test("a changed file gets a formatting label and a changed-line count", () => {
  const out = buildAutoFixSummary(
    snap({ "a.ts": { mtime: 1, text: "const a=1\n" } }),
    snap({ "a.ts": { mtime: 2, text: "const a = 1;\n" } }),
    NO_COUNTS,
    false
  );

  expect(out.files).toEqual(["a.ts"]);
  expect(out.summary).toEqual(["a.ts (formatting, 2 lines)"]);
});

test("fixer counts attribute the change, singular/plural correct", () => {
  const counts = new Map<string, IFixCounts>([
    ["a.ts", { tsQuickFixes: 2, importsOrganized: 1, idiomRewrites: 0 }],
    ["b.ts", { tsQuickFixes: 1, importsOrganized: 0, idiomRewrites: 3 }],
  ]);
  const out = buildAutoFixSummary(
    snap({
      "a.ts": { mtime: 1, text: "1\n" },
      "b.ts": { mtime: 1, text: "1\n" },
    }),
    snap({
      "a.ts": { mtime: 2, text: "2\n" },
      "b.ts": { mtime: 2, text: "2\n" },
    }),
    counts,
    false
  );

  expect(out.summary).toEqual([
    "a.ts (2 TS quick-fixes, imports organized, 2 lines)",
    "b.ts (1 TS quick-fix, 3 idiom rewrites, 2 lines)",
  ]);
});

test("an mtime-advanced file without comparable content stays reported, lines unknown", () => {
  const out = buildAutoFixSummary(
    snap({ "big.ts": { mtime: 1 } }),
    snap({ "big.ts": { mtime: 2 } }),
    NO_COUNTS,
    true
  );

  expect(out.summary).toEqual(["big.ts (formatting/fix)"]);
});

test("an unchanged mtime is never reported, even with fixer counts recorded", () => {
  const counts = new Map<string, IFixCounts>([
    ["a.ts", { tsQuickFixes: 1, importsOrganized: 0, idiomRewrites: 0 }],
  ]);
  const out = buildAutoFixSummary(
    snap({ "a.ts": { mtime: 5, text: "x\n" } }),
    snap({ "a.ts": { mtime: 5, text: "x\n" } }),
    counts,
    false
  );

  expect(out.files).toEqual([]);
});
