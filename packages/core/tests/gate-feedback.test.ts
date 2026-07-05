import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateFeedback } from "../src/loop/feedback";
import type { ITask } from "../src/spec";
import type { ErrorSet } from "../src/validate";

const TASK: ITask = {
  id: "1",
  files: ["money.ts"],
  accept: "tsc -p tsconfig.json",
  intent: "",
};

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-fb-"));

  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("gateFeedback shows location + the offending source line (no hand-counting)", async () => {
  await withDir(async (dir) => {
    await Bun.write(
      join(dir, "money.ts"),
      [
        "export function allocate(total: number, ratios: number[]): number[] {",
        "  for (let i = 0; i < ratios.length; i += 1) {",
        "    const share = (total * ratios[i]) / 3;",
        "  }",
        "  return [];",
        "}",
      ].join("\n")
    );

    const errors: ErrorSet = [
      {
        key: "money.ts:3:TS2532",
        file: "money.ts",
        line: 3,
        rule: "TS2532",
        message: "Object is possibly 'undefined'.",
      },
    ];

    const fb = await gateFeedback(errors, TASK, dir);

    expect(fb).toContain("money.ts:3");
    expect(fb).toContain("[TS2532]");
    // The actual code at line 3 is inlined — the model needn't read+count.
    expect(fb).toContain("const share = (total * ratios[i]) / 3;");
  });
});

test("gateFeedback degrades gracefully when an error has no location", async () => {
  await withDir(async (dir) => {
    const errors: ErrorSet = [
      { key: "nonzero", message: "command exited non-zero" },
    ];

    const fb = await gateFeedback(errors, TASK, dir);

    expect(fb).toContain("command exited non-zero");
  });
});

test("gateFeedback caps repeats of one rule so other rules still surface", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "money.ts"), "export const x = 1;\n");

    // 25× the same rule would previously wall the whole 20-line budget and
    // the single OTHER error (a different rule, emitted last) was truncated.
    const noisy: ErrorSet = Array.from({ length: 25 }, (_, i) => ({
      key: `money.ts:${i + 1}:no-explicit-any`,
      file: "money.ts",
      line: 1,
      rule: "no-explicit-any",
      message: "Unexpected any.",
    }));
    const errors: ErrorSet = [
      ...noisy,
      {
        key: "money.ts:1:TS2304",
        file: "money.ts",
        line: 1,
        rule: "TS2304",
        message: "Cannot find name 'foo'.",
      },
    ];

    const fb = await gateFeedback(errors, TASK, dir);

    // The distinct rule must be rendered in full, not truncated away.
    expect(fb).toContain("[TS2304]");
    expect(fb).toContain("Cannot find name 'foo'.");
    // The noisy rule is summarized, not repeated 25 times.
    expect(fb).toContain("22 more [no-explicit-any]");
    expect((fb.match(/Unexpected any\./g) ?? []).length).toBeLessThanOrEqual(3);
  });
});

test("gateFeedback summarizes overflow by rule with affected files", async () => {
  await withDir(async (dir) => {
    await Bun.write(join(dir, "money.ts"), "export const x = 1;\n");

    const errors: ErrorSet = Array.from({ length: 30 }, (_, i) => ({
      key: `money.ts:${i + 1}:TS2532`,
      file: "money.ts",
      line: 1,
      rule: "TS2532",
      message: "Object is possibly 'undefined'.",
    }));

    const fb = await gateFeedback(errors, TASK, dir);

    expect(fb).toContain("same rules, same fixes apply");
    expect(fb).toContain("27 more [TS2532] in money.ts");
  });
});
