import { test, expect, describe } from "bun:test";
import {
  condenseTestRunner,
  condenseToolOutput,
} from "../src/loop/tools/condense";
import { parseTestFailures, parserFor } from "../src/validate/parse";

const GREEN_BUN = `
bun test v1.3.14

src/a.test.ts:
(pass) a > works [1.00ms]
(pass) a > also [0.50ms]

src/b.test.ts:
(pass) b > ok [0.20ms]

 3 pass
 0 fail
`;

const RED_BUN = `
bun test v1.3.14

src/a.test.ts:
(pass) a > works [1.00ms]
(fail) a > breaks [2.00ms]
  error: expect(received).toBe(expected)
  Expected: 1
  Received: 2
      at <anonymous> (/tmp/a.test.ts:10:20)

 2 pass
 1 fail
`;

describe("condenseTestRunner", () => {
  test("green bun test collapses to one-liner without pass list", () => {
    const out = condenseTestRunner({
      command: "bun test",
      output: GREEN_BUN,
      exitCode: 0,
    });

    expect(out).toBe("tests ✓ — 3 pass (pass list elided)");
    expect(out ?? "").not.toContain("(pass) a > works");
  });

  test("red bun test keeps fail lines and drops pass rows", () => {
    const out = condenseTestRunner({
      command: "bun test",
      output: RED_BUN,
      exitCode: 1,
    });

    expect(out ?? "").toContain("(fail) a > breaks");
    expect(out ?? "").toContain("Expected: 1");
    expect(out ?? "").not.toContain("(pass) a > works");
    expect(out ?? "").toMatch(/1 fail/);
  });

  test("keeps bun assertion block printed ABOVE the (fail) line", () => {
    // Live bun order (not the older below-(fail) fixture): code frame + error
    // first, then `(fail) …`. Dropping the above-block made the model claim
    // "error detail is genuinely not in the output".
    const BUN_FAIL_ABOVE = `
bun test v1.3.14

src/db.test.ts:
DEBUG noise should drop
17 |     expect(tables).toContain("purchase_order_lines");
                        ^
error: expect(received).toContain(expected)

Expected to contain: "purchase_order_lines"
Received: [ "_migrations", "products", "purchase_orders", "sales_order_lines",
  "sales_orders", "stock_moves"
]

      at <anonymous> (/tmp/db.test.ts:17:20)
(fail) db > migrations are idempotent [2.45ms]

 0 pass
 1 fail
`;

    const out = condenseTestRunner({
      command: "bun test src/db.test.ts",
      output: BUN_FAIL_ABOVE,
      exitCode: 1,
    });

    expect(out ?? "").toContain("purchase_order_lines");
    expect(out ?? "").toContain("Expected to contain");
    expect(out ?? "").toContain("(fail) db > migrations are idempotent");
    expect(out ?? "").not.toContain("DEBUG noise");
  });

  test("pipeline picks test-runner condenser for bun test", () => {
    const { text, via } = condenseToolOutput(
      { command: "bun test", output: GREEN_BUN, exitCode: 0 },
      4000
    );

    expect(via).toBe("test-runner");
    expect(text).toContain("pass list elided");
  });

  test("preload / footer failures stay RED even when | cat masks exit to 0", () => {
    // Real bun shape when happy-dom preload is missing: footer says fail/errors,
    // no "(fail)" rows, and `bun test 2>&1 | cat` reports exit 0. The old
    // condenser turned that into "tests ✓ — 0 pass" and the model looped.
    const PRELOAD_RED = `
bun test v1.3.14

src/streak.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module '@happy-dom/global-registrator' from '/tmp/src/test-setup.ts'
-------------------------------


src/useHabits.test.ts:

# Unhandled error between tests
-------------------------------
-------------------------------


 0 pass
 5 fail
 5 errors
Ran 5 tests across 5 files. [6.00ms]
`;

    const out = condenseTestRunner({
      command: "bun test 2>&1 | cat",
      output: PRELOAD_RED,
      exitCode: 0,
    });

    expect(out ?? "").toMatch(/^tests ✗/);
    expect(out ?? "").toContain("5 fail");
    expect(out ?? "").toContain("@happy-dom/global-registrator");
    expect(out ?? "").not.toContain("tests ✓");
    expect(out ?? "").not.toMatch(/0 pass \(pass list elided\)/);
  });
});

describe("parseTestFailures / parserFor", () => {
  test("parseTestFailures extracts bun (fail) rows", () => {
    const items = parseTestFailures(RED_BUN);

    expect(items.some((e) => e.rule === "bun-test")).toBe(true);
    expect(items.some((e) => e.message.includes("breaks"))).toBe(true);
  });

  test("parserFor(bun test) returns structured fails not generic blob", () => {
    const parse = parserFor("bun test");
    const items = parse(RED_BUN);

    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.rule).toBe("bun-test");
    expect(items[0]?.message ?? "").not.toContain("2 pass");
  });
});
