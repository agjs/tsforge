import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";

/** A provider that yields immediately (no tool calls) — the "model is done" case. */
function yields(content = "ok"): IProvider {
  return {
    async complete() {
      return { content, toolCalls: [] };
    },
  };
}

test("no gate → one conversational turn, conversation retained", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const session = await Session.create({
      provider: yields("hello"),
      cwd: dir,
    });
    const result = await session.send("hi");

    expect(result.status).toBe("responded");
    expect(result.turns).toBe(1);
    // system + user + assistant
    expect(session.messages.length).toBe(3);
    expect(session.messages.at(-1)?.content).toBe("hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a gate does NOT fire on a pure answer (no edits) — stays conversational", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    // Gate set, but the model only answers (no edits) → no gate run.
    const session = await Session.create({
      provider: yields("here is the answer"),
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });
    const result = await session.send("what does this do?");

    expect(result.status).toBe("responded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gate-confirms AFTER the model edits: green gate → done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    // Turn 1: create a file (an edit). Turn 2: yield → gate runs (passes) → done.
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true", // a gate that always passes
      files: ["**/*"],
    });
    const result = await session.send("create x.ts");

    expect(result.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The narrate-instead-of-build failure: a gated build turn where the model writes
// whole files into its message (fenced blocks) instead of calling `create`. The
// content never reaches disk, so the session must NOT accept it as "responded".
const CODE_DUMP =
  "I'll build it. First the types:\n\n```ts\nexport interface Issue { id: string }\n```\n\n" +
  "Now the component:\n\n```tsx\nexport function App() { return <div/>; }\n```\n";

test("gated build: model dumps code as prose, never acts → nudged then stuck", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        return { content: CODE_DUMP, toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });
    const result = await session.send("build a Linear clone");

    // Not silently "responded": nudged maxBuildNudges times, then gave up.
    expect(result.status).toBe("stuck");
    // 2 nudges + the turn that hits the cap = 3 model calls.
    expect(calls).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gated build: a code-dump nudge recovers when the model then creates files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        if (calls === 1) {
          return { content: CODE_DUMP, toolCalls: [] }; // dumps → gets nudged
        }

        if (calls === 2) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                arguments: { file: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] }; // yields → gate runs → done
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });
    const result = await session.send("build a Linear clone");

    expect(result.status).toBe("done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// P1: a create via the `path` alias (not `file`) still WRITES the file, so the
// session must count it as an edit and run the gate — not return "responded".
test("gated build: create({ path }) alias counts as an edit and reaches the gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "create",
                // `path`, not `file` — the alias the model often reaches for.
                arguments: { path: "x.ts", content: "export const x = 1;\n" },
              },
            ],
          };
        }

        return { content: "done", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });
    const result = await session.send("create x.ts");

    // The file was written AND the gate ran → done, not a silent "responded".
    expect(result.status).toBe("done");
    expect(await Bun.file(join(dir, "x.ts")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send returns 'interrupted' when its signal is aborted mid-turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    // A provider that never resolves on its own — only the abort ends it.
    const provider: IProvider = {
      async complete(_messages, opts) {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      },
    };
    const session = await Session.create({ provider, cwd: dir });
    const controller = new AbortController();
    const pending = session.send("do something slow", {
      signal: controller.signal,
    });

    controller.abort();

    expect((await pending).status).toBe("interrupted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compact replaces the conversation with [system, summary]", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const provider: IProvider = {
      async complete() {
        return { content: "SUMMARY", toolCalls: [] };
      },
    };
    const session = await Session.create({ provider, cwd: dir });

    await session.send("do a thing");
    const before = session.messages.length; // system + user + assistant

    const result = await session.compact();

    expect(result.before).toBe(before);
    expect(session.messages.length).toBe(2); // system + summary
    expect(session.messages[0]?.role).toBe("system");
    expect(session.messages[1]?.content).toContain("SUMMARY");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("steer injects a queued message before the next turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    // Turn 1 keeps working (a tool call); turn 2 yields. The steer callback
    // queues a message that should land before turn 2's model call.
    let calls = 0;
    const provider: IProvider = {
      async complete() {
        calls += 1;

        if (calls === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "read", arguments: { file: "x.ts" } }],
          };
        }

        return { content: "ok", toolCalls: [] };
      },
    };
    const session = await Session.create({ provider, cwd: dir });

    let steerCalls = 0;

    await session.send("start", {
      steer: () => {
        steerCalls += 1;

        return steerCalls === 2 ? ["actually use Tailwind"] : [];
      },
    });

    expect(
      session.messages.some((m) => m.content === "actually use Tailwind")
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each send appends to the same persistent conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-session-"));

  try {
    const session = await Session.create({ provider: yields(), cwd: dir });

    await session.send("first");
    const afterFirst = session.messages.length;

    await session.send("second");

    expect(session.messages.length).toBe(afterFirst + 2); // user + assistant
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
