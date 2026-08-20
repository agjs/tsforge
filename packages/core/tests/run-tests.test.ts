import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTests, isRealRed } from "../src/validate";

test("counts collected tests (pass + fail) from a real run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-runtests-"));

  try {
    await Bun.write(
      join(dir, "x.test.ts"),
      [
        'import { test, expect } from "bun:test";',
        'test("a", () => { expect(1).toBe(1); });',
        'test("b", () => { expect(2).toBe(2); });',
        'test("c", () => { expect(1).toBe(2); });',
      ].join("\n")
    );

    const r = await runTests("x.test.ts", dir);

    expect(r.pass).toBe(2);
    expect(r.fail).toBe(1);
    expect(r.total).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The load-bearing case: an empty file EXITS 0 but collects nothing. Exit code
// would call it "green"; only the collected-count exposes it as vacuous.
test("reports total 0 for an empty (vacuous) test file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-runtests-"));

  try {
    await Bun.write(join(dir, "empty.test.ts"), "");

    const r = await runTests("empty.test.ts", dir);

    expect(r.total).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The bug a live run exposed: a file that fails to LOAD (missing import, syntax
// error) is reported by bun as "1 fail / Ran 1 test" — an error masquerading as
// a real test. `errors` must surface it so callers don't mistake it for a suite.
test("surfaces a load failure as an error, not a real test", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-runtests-"));

  try {
    await Bun.write(
      join(dir, "broken.test.ts"),
      [
        'import { nope } from "./does-not-exist";',
        'import { test, expect } from "bun:test";',
        'test("t", () => { expect(nope()).toBe(1); });',
      ].join("\n")
    );

    const r = await runTests("broken.test.ts", dir);

    expect(r.errors).toBeGreaterThanOrEqual(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 1.2: count derivation must read bun's SUMMARY lines, not the first `\d+ pass`
// found anywhere. A passing test whose console output contains a summary-shaped
// string used to spoof pass:0/fail:5 from the log line — flipping isRealRed to
// accept a passing suite as a real RED one (a false TDD-floor pass).
test("test log output cannot spoof the collected counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-runtests-"));

  try {
    await Bun.write(
      join(dir, "spoof.test.ts"),
      [
        'import { test, expect } from "bun:test";',
        'test("logs a summary-shaped string", () => {',
        '  console.log("simulating: 0 pass 5 fail  Ran 9 tests");',
        "  expect(1).toBe(1);",
        "});",
      ].join("\n")
    );

    const r = await runTests("spoof.test.ts", dir);

    // The REAL summary is 1 pass / 0 fail / 1 total, not the logged 0/5/9.
    expect(r.pass).toBe(1);
    expect(r.fail).toBe(0);
    expect(r.total).toBe(1);
    expect(isRealRed(r)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
