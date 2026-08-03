import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelAgent } from "../src/agent";
import type { IProvider, IChatMessage } from "../src/inference";
import type { ILoopEvent } from "../src/loop/loop.types";

function providerReturning(
  toolCalls: { name: string; arguments: Record<string, unknown> }[]
): IProvider {
  return {
    async complete() {
      return { content: "", toolCalls };
    },
  };
}

test("applies the model's edit tool calls via the edit engine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-model-"));

  try {
    await Bun.write(join(dir, "a.ts"), "const x = 1;\n");
    const agent = modelAgent(
      providerReturning([
        {
          name: "edit",
          arguments: { file: "a.ts", oldString: "1", newString: "2" },
        },
      ])
    );

    await agent.implement({
      cwd: dir,
      task: { id: "1", accept: "true", files: ["a.ts"] },
      errors: [],
      cycle: 1,
    });

    expect(await Bun.file(join(dir, "a.ts")).text()).toBe("const x = 2;\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizes absolute in-workspace paths before scope checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-model-"));

  try {
    const abs = join(dir, "a.ts");

    await Bun.write(abs, "const x = 1;\n");
    const agent = modelAgent(
      providerReturning([
        {
          name: "edit",
          arguments: { file: abs, oldString: "1", newString: "2" },
        },
      ])
    );

    await agent.implement({
      cwd: dir,
      task: { id: "1", accept: "true", files: ["a.ts"] },
      errors: [],
      cycle: 1,
    });

    expect(await Bun.file(abs).text()).toBe("const x = 2;\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("passes the task + current errors to the model", async () => {
  let seen: IChatMessage[] = [];
  const provider: IProvider = {
    async complete(messages) {
      seen = messages;

      return { content: "", toolCalls: [] };
    },
  };

  await modelAgent(provider).implement({
    cwd: ".",
    task: { id: "7", accept: "bun test tickets", files: ["a.ts"] },
    errors: [{ key: "k", message: "boom at line 4" }],
    cycle: 2,
  });

  const text = seen.map((m) => m.content).join("\n");

  expect(text).toContain("bun test tickets");
  expect(text).toContain("boom at line 4");
});

test("ignores non-edit calls and malformed edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-model-"));

  try {
    await Bun.write(join(dir, "a.ts"), "keep\n");
    const agent = modelAgent(
      providerReturning([
        { name: "search", arguments: { q: "x" } },
        { name: "edit", arguments: { file: "a.ts", oldString: "keep" } }, // no newString
      ])
    );

    await agent.implement({
      cwd: dir,
      task: { id: "1", accept: "true", files: ["a.ts"] },
      errors: [],
      cycle: 1,
    });

    expect(await Bun.file(join(dir, "a.ts")).text()).toBe("keep\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applies the model's create tool calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-model-"));

  try {
    const agent = modelAgent(
      providerReturning([
        {
          name: "create",
          arguments: { file: "greet.ts", content: "export const hi = 1;\n" },
        },
      ])
    );

    await agent.implement({
      cwd: dir,
      task: { id: "1", accept: "true", files: ["greet.ts"] },
      errors: [],
      cycle: 1,
    });

    expect(await Bun.file(join(dir, "greet.ts")).text()).toBe(
      "export const hi = 1;\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feeds a rejected edit back to the next cycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-model-"));

  try {
    await Bun.write(join(dir, "a.ts"), "x\nx\n"); // "x" matches twice → ambiguous
    const prompts: string[] = [];
    let n = 0;
    const provider: IProvider = {
      async complete(messages) {
        n += 1;
        prompts.push(messages.map((m) => m.content).join("\n"));

        if (n === 1) {
          return {
            content: "",
            toolCalls: [
              {
                name: "edit",
                arguments: { file: "a.ts", oldString: "x", newString: "y" },
              },
            ],
          };
        }

        return { content: "", toolCalls: [] };
      },
    };
    const agent = modelAgent(provider);
    const task = { id: "1", accept: "true", files: ["a.ts"] };

    await agent.implement({ cwd: dir, task, errors: [], cycle: 1 });
    await agent.implement({ cwd: dir, task, errors: [], cycle: 2 });

    expect(prompts[1]?.toLowerCase()).toContain("rejected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects edits outside the editable scope (read-only context)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-model-"));

  try {
    await Bun.write(join(dir, "spec.test.ts"), "readonly\n");
    const prompts: string[] = [];
    let n = 0;
    const provider: IProvider = {
      async complete(messages) {
        n += 1;
        prompts.push(messages.map((m) => m.content).join("\n"));

        if (n === 1) {
          return {
            content: "",
            toolCalls: [
              {
                name: "edit",
                arguments: {
                  file: "spec.test.ts",
                  oldString: "readonly",
                  newString: "hacked",
                },
              },
            ],
          };
        }

        return { content: "", toolCalls: [] };
      },
    };
    const agent = modelAgent(provider);
    const task = {
      id: "1",
      accept: "true",
      files: ["impl.ts"],
      context: ["spec.test.ts"],
    };

    await agent.implement({ cwd: dir, task, errors: [], cycle: 1 });
    // The out-of-scope edit must NOT have applied.
    expect(await Bun.file(join(dir, "spec.test.ts")).text()).toBe("readonly\n");

    await agent.implement({ cwd: dir, task, errors: [], cycle: 2 });
    expect(prompts[1]?.toLowerCase()).toContain("scope");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shows the spec intent (contract) to the model", async () => {
  let user = "";
  const provider: IProvider = {
    async complete(messages) {
      user = messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");

      return { content: "", toolCalls: [] };
    },
  };

  await modelAgent(provider).implement({
    cwd: ".",
    task: {
      id: "1",
      accept: "x",
      files: [],
      intent: "discounted = max(0, subtotal - discountCents)",
    },
    errors: [],
    cycle: 1,
  });

  // The contract reaches the model, so it stops reverse-engineering from tests.
  expect(user).toContain("discountCents");
});

test("system prompt states the house rules", async () => {
  let captured = "";
  const provider: IProvider = {
    async complete(messages) {
      captured = messages.find((m) => m.role === "system")?.content ?? "";

      return { content: "", toolCalls: [] };
    },
  };

  await modelAgent(provider).implement({
    cwd: ".",
    task: { id: "1", accept: "x", files: [] },
    errors: [],
    cycle: 1,
  });

  const lower = captured.toLowerCase();

  expect(lower).toContain("non-null");
  expect(lower).toContain("guard");
  expect(lower).toContain("interface");
});

// modelAgent backs the QUALITY-REPAIR pass, which is on by default. It reported its
// edits but not its tokens, so quality-phase edits entered the net-accepted count
// while its cost did not — costPerAcceptedChange came out systematically low on
// green runs, making the variants that passed most often look cheapest.
test("reports the provider's token usage so quality-phase cost is counted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-model-"));

  try {
    await Bun.write(join(dir, "a.ts"), "keep\n");

    const events: ILoopEvent[] = [];
    const agent = modelAgent({
      async complete() {
        return {
          content: "no change needed",
          toolCalls: [],
          usage: { promptTokens: 120, completionTokens: 340, totalTokens: 460 },
        };
      },
    });

    await agent.implement({
      cwd: dir,
      task: { id: "1", accept: "true", files: ["a.ts"] },
      errors: [],
      cycle: 1,
      report: (event) => events.push(event),
    });

    const usage = events.filter((e) => e.kind === "usage");

    expect(usage.length).toBe(1);
    // The fields the metrics library actually reads — a usage event without them is
    // inert, and tokensOut would stay 0.
    expect(usage[0]?.completionTokens).toBe(340);
    expect(usage[0]?.promptTokens).toBe(120);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
