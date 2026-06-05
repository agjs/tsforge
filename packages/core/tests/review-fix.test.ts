import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewAndFixSuite } from "../src/spec/review-tests";
import type { IProvider } from "../src/inference/types";

const STUB =
  'export function add(a: number, b: number): number {\n  throw new Error("nope");\n}\n';

// A real, RED suite (imports the throwing stub, so every test fails).
const RED_ORIGINAL = [
  'import { test, expect } from "bun:test";',
  'import { add } from "./g";',
  'test("orig", () => { expect(add(1, 1)).toBe(2); });',
].join("\n");

function cannedJudge(correctedSuite: string): IProvider {
  return {
    async complete() {
      return {
        content: JSON.stringify({
          findings: [{ test: "orig", kind: "over-strict", reason: "x" }],
          correctedSuite,
        }),
        toolCalls: [],
      };
    },
  };
}

async function seed(dir: string): Promise<void> {
  await Bun.write(join(dir, "g.ts"), STUB);
  await Bun.write(join(dir, "g.test.ts"), RED_ORIGINAL);
}

test("applies a correction that stays real + RED", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-reviewfix-"));

  try {
    await seed(dir);

    const corrected = [
      'import { test, expect } from "bun:test";',
      'import { add } from "./g";',
      'test("fixed", () => { expect(add(2, 2)).toBe(4); });',
    ].join("\n");

    const r = await reviewAndFixSuite(cannedJudge(corrected), dir, {
      testFile: "g.test.ts",
      implFile: "g.ts",
      goal: "addition",
      criteria: "add sums",
    });

    expect(r.applied).toBe(true);
    expect(await Bun.file(join(dir, "g.test.ts")).text()).toContain('"fixed"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Safeguard: a "correction" that is vacuous (passes against the stub) must be
// REVERTED — review can only ever hand the loop a still-RED suite.
test("reverts a correction that breaks the RED guarantee", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-reviewfix-"));

  try {
    await seed(dir);

    const vacuous = [
      'import { test, expect } from "bun:test";',
      'test("trivial", () => { expect(1).toBe(1); });',
    ].join("\n");

    const r = await reviewAndFixSuite(cannedJudge(vacuous), dir, {
      testFile: "g.test.ts",
      implFile: "g.ts",
      goal: "addition",
      criteria: "add sums",
    });

    expect(r.applied).toBe(false);
    // original suite preserved
    expect(await Bun.file(join(dir, "g.test.ts")).text()).toContain('"orig"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no correction (empty correctedSuite) leaves the suite untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-reviewfix-"));

  try {
    await seed(dir);

    const r = await reviewAndFixSuite(cannedJudge(""), dir, {
      testFile: "g.test.ts",
      implFile: "g.ts",
      goal: "addition",
      criteria: "add sums",
    });

    expect(r.applied).toBe(false);
    expect(await Bun.file(join(dir, "g.test.ts")).text()).toContain('"orig"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
