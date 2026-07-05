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

// Regression: `ITask.files` is documented as "editable scope GLOBS". `score()`
// used to read each entry literally (`Bun.file(join(cwd, "src/**/*.ts")).text()`),
// which throws ENOENT on a glob — crashing the whole repair before the first
// judge call. It must expand globs through the shared walker, like `scopeCode`.
test("scores a GLOB-scoped task without throwing (globs are expanded)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-quality-glob-"));

  try {
    await Bun.write(join(dir, "src", "a.ts"), "export const a = 1;");
    await Bun.write(join(dir, "src", "b.ts"), "export const b = 2;");

    const seen: string[] = [];
    const judgeProvider: IProvider = {
      async complete(messages) {
        seen.push(messages.map((m) => m.content).join("\n"));

        return {
          content: JSON.stringify({
            overall: 5,
            correctness: 5,
            design: 5,
            readability: 5,
            notes: "great",
          }),
          toolCalls: [],
        };
      },
    };
    const agent: IAgent = {
      async implement() {
        // already at target; never invoked
      },
    };

    const result = await qualityRepair(
      { id: "1", accept: "true", files: ["src/**/*.ts"] },
      dir,
      agent,
      judgeProvider,
      { goal: "g", criteria: "c" },
      { target: 5, maxAttempts: 1 }
    );

    expect(result.quality).toBe(5);
    // The judge actually saw both glob-matched files' contents.
    expect(seen[0]).toContain("export const a = 1;");
    expect(seen[0]).toContain("export const b = 2;");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression: an empty scope (glob matched nothing / all over the size cap) must
// NOT send an empty code window to the judge — it scores unpredictably and wastes
// an LLM call. score() returns the floor without calling the provider.
test("an empty scope returns the floor without calling the judge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-quality-empty-"));

  try {
    let judgeCalls = 0;
    const judgeProvider: IProvider = {
      async complete() {
        judgeCalls += 1;

        return { content: JSON.stringify({ overall: 5 }), toolCalls: [] };
      },
    };
    const agent: IAgent = {
      async implement() {
        // no-op: nothing to edit when the scope is empty
      },
    };

    const result = await qualityRepair(
      { id: "1", accept: "true", files: ["does/not/exist/**/*.ts"] },
      dir,
      agent,
      judgeProvider,
      { goal: "g", criteria: "c" },
      { target: 5, maxAttempts: 2 }
    );

    expect(judgeCalls).toBe(0); // never judged an empty window — the point of the guard
    expect(result.quality).toBe(0); // floor, not an unpredictable empty-window score
    expect(result.notes).toContain("no files in scope");
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

// Regression: a THROW mid-attempt (agent error, fix crash, gate runner failure)
// must roll the workspace back to the green baseline before propagating —
// otherwise a half-applied edit batch is left on disk over green code. Mirrors
// review-repair.ts's try/catch-restore-rethrow.
test("a throw mid-attempt restores the snapshot before rethrowing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-quality-throw-"));

  try {
    await Bun.write(join(dir, "a.ts"), "baseline");

    const agent: IAgent = {
      async implement(ctx) {
        await Bun.write(join(ctx.cwd, "a.ts"), "// HALF-APPLIED");

        throw new Error("agent exploded mid-repair");
      },
    };

    await expect(
      qualityRepair(
        { id: "1", accept: "true", files: ["a.ts"] },
        dir,
        agent,
        risingJudge([3]), // parseable 3/5 → enters the improvement loop
        { goal: "g", criteria: "c" },
        { target: 5, maxAttempts: 1 }
      )
    ).rejects.toThrow("agent exploded mid-repair");

    // The half-applied edit must be rolled back, not left on disk.
    expect(await Bun.file(join(dir, "a.ts")).text()).toBe("baseline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression: an UNPARSEABLE judge response (judge infra failure, not a real 0/5)
// must NOT enter the improvement loop. Feeding the generator "a reviewer scored you
// 0/5: 'unparseable judge response'" is a nonsense critique it can't act on — live,
// the model spiraled on it and burned attempts. Treat it as no-signal: keep the
// green baseline, run no improvement attempt.
test("an unparseable judge response is no-signal — no improvement attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-quality-unparse-"));

  try {
    await Bun.write(join(dir, "a.ts"), "export const a = 1;");

    let implementCalls = 0;
    const agent: IAgent = {
      async implement() {
        implementCalls += 1;
      },
    };
    // Judge returns prose, not the required JSON → unparseable → scored:false.
    const judgeProvider: IProvider = {
      async complete() {
        return { content: "Looks fine to me, honestly.", toolCalls: [] };
      },
    };

    const result = await qualityRepair(
      { id: "1", accept: "true", files: ["a.ts"] },
      dir,
      agent,
      judgeProvider,
      { goal: "g", criteria: "c" },
      { target: 5, maxAttempts: 2 }
    );

    expect(implementCalls).toBe(0); // never fed the model a nonsense "0/5" critique
    expect(result.attempts).toBe(0);
    expect(result.notes).toContain("unparseable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
