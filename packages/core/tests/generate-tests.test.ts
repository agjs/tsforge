import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTests } from "../src/spec/generate-tests";
import type { IProvider } from "../src/inference/types";

// A throwing stub: every call fails, so a REAL test (one that invokes the impl)
// must go RED against it. A vacuous test that never calls the impl stays green.
const STUB =
  'export function add(a: number, b: number): number {\n  throw new Error("not implemented");\n}\n';

// Imports the stub and asserts real behaviour → fails against the throwing stub.
const REAL = [
  'import { test, expect } from "bun:test";',
  'import { add } from "./g";',
  'test("adds", () => { expect(add(1, 1)).toBe(2); });',
].join("\n");

// Never touches the impl → passes even against the stub → must be rejected.
const VACUOUS = [
  'import { test, expect } from "bun:test";',
  'test("trivial", () => { expect(1).toBe(1); });',
].join("\n");

// Provider that emits a stub create + the next canned test-file create per turn.
function providerWriting(testContents: string[]): IProvider {
  let n = 0;

  return {
    async complete() {
      const content = testContents[Math.min(n, testContents.length - 1)] ?? "";

      n += 1;

      return {
        content: "",
        toolCalls: [
          { name: "create", arguments: { file: "g.ts", content: STUB } },
          { name: "create", arguments: { file: "g.test.ts", content } },
        ],
      };
    },
  };
}

const BASE = {
  testFile: "g.test.ts",
  implFile: "g.ts",
  goal: "addition",
  criteria: "A1. add(1, 1) === 2",
};

test("accepts a suite that loads, collects tests, and is RED against the stub", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-gentests-"));

  try {
    const r = await generateTests(providerWriting([REAL]), dir, BASE);

    expect(r.ok).toBe(true);
    expect(r.testCount).toBe(1);
    expect(r.attempts).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The honest guard: a suite that PASSES against a do-nothing stub isn't testing
// the implementation. It must be rejected and regenerated, then accepted.
test("rejects a vacuous (passes-against-stub) suite, then accepts a real one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-gentests-"));

  try {
    const r = await generateTests(providerWriting([VACUOUS, REAL]), dir, {
      ...BASE,
      maxAttempts: 3,
    });

    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gives up after maxAttempts when the suite never goes RED", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-gentests-"));

  try {
    const r = await generateTests(providerWriting([VACUOUS]), dir, {
      ...BASE,
      maxAttempts: 2,
    });

    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
