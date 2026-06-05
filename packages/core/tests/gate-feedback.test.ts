import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateFeedback } from "../src/loop/run";
import type { ITask } from "../src/spec/types";
import type { ErrorSet } from "../src/validate/errors";

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
