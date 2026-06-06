import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualityRepair } from "../src/loop";
import type { IAgent } from "../src/agent";
import type { IProvider } from "../src/inference";

// Judge that returns a rising score on each successive call.
function risingJudge(scores: number[]): IProvider {
  let n = 0;

  return {
    async complete() {
      const v = scores[Math.min(n, scores.length - 1)] ?? 0;

      n += 1;

      return {
        content: JSON.stringify({
          overall: v,
          correctness: v,
          design: v,
          readability: v,
          notes: "improve it",
        }),
        toolCalls: [],
      };
    },
  };
}

test("drives quality up, keeping improvements, until target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-quality-"));

  try {
    await Bun.write(join(dir, "a.ts"), "v1");

    let edits = 0;
    const agent: IAgent = {
      async implement(ctx) {
        edits += 1;
        await Bun.write(join(ctx.cwd, "a.ts"), `v${edits + 1}`);
      },
    };

    const result = await qualityRepair(
      { id: "1", accept: "true", files: ["a.ts"] }, // gate always green
      dir,
      agent,
      risingJudge([3, 4, 5]),
      { goal: "g", criteria: "c" },
      { target: 5, maxAttempts: 3 }
    );

    expect(result.quality).toBe(5);
    expect(result.attempts).toBe(2); // 3 → 4 → 5
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reverts an attempt that breaks the gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-quality-"));

  try {
    await Bun.write(join(dir, "ok.txt"), "green");
    await Bun.write(join(dir, "a.ts"), ""); // baseline (green) version to revert to
    // accept passes only while ok.txt exists; the agent deletes it (regression).
    const agent: IAgent = {
      async implement(ctx) {
        await rm(join(ctx.cwd, "ok.txt"), { force: true });
        await Bun.write(join(ctx.cwd, "a.ts"), "changed");
      },
    };

    const result = await qualityRepair(
      { id: "1", accept: "test -f ok.txt", files: ["a.ts"] },
      dir,
      agent,
      risingJudge([3, 5]),
      { goal: "g", criteria: "c" },
      { target: 5, maxAttempts: 1 }
    );

    // The improvement broke the gate → reverted → a.ts restored to baseline.
    expect(result.quality).toBe(3);
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
