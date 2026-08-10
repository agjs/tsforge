import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";
import { isReadOnlyCommand } from "../src/loop/tools/file-ops";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-plan-"));

  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("plan mode rejects a write tool at the execute layer — nothing reaches disk", async () => {
  await withDir(async (dir) => {
    let calls = 0;
    const toolResults: string[] = [];
    const provider: IProvider = {
      async complete(messages) {
        calls += 1;

        const last = messages.at(-1);

        if (last?.role === "tool") {
          toolResults.push(last.content);
        }

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

        return { content: "understood — planning instead", toolCalls: [] };
      },
    };
    const session = await Session.create({
      provider,
      cwd: dir,
      files: ["**/*"],
    });

    session.setPlanMode(true);

    const result = await session.send("add a module");

    expect(result.status).toBe("responded");
    expect(existsSync(join(dir, "x.ts"))).toBe(false);
    expect(toolResults.some((t) => t.includes("plan mode"))).toBe(true);
  });
});

test("plan mode advertises only read-only tools; toggling off restores writes", async () => {
  await withDir(async (dir) => {
    const offered: string[][] = [];
    const provider: IProvider = {
      async complete(_messages, opts) {
        offered.push(
          (opts?.tools ?? []).map(
            (t) => (t as { function: { name: string } }).function.name
          )
        );

        return { content: "ok", toolCalls: [] };
      },
    };
    const session = await Session.create({ provider, cwd: dir });

    session.setPlanMode(true);
    await session.send("explore");

    expect(offered.at(-1)).toEqual(["read", "run"]); // base set minus edit/create

    session.setPlanMode(false);
    await session.send("now build");

    expect(offered.at(-1)).toContain("edit");
    expect(offered.at(-1)).toContain("create");
  });
});

test("a fenced-snippet-heavy plan never trips the code-dump build nudge", async () => {
  await withDir(async (dir) => {
    let calls = 0;
    const PLAN_WITH_SNIPPETS =
      "## Plan\n\n1. types:\n```ts\nexport interface A { id: string }\n```\n" +
      "2. component:\n```tsx\nexport function App() { return <div/>; }\n```\n";
    const provider: IProvider = {
      async complete() {
        calls += 1;

        return { content: PLAN_WITH_SNIPPETS, toolCalls: [] };
      },
    };
    // A gate is set — without plan mode this reply would be nudged as a dump.
    const session = await Session.create({
      provider,
      cwd: dir,
      accept: "true",
      files: ["**/*"],
    });

    session.setPlanMode(true);

    const result = await session.send("build the app");

    expect(result.status).toBe("responded");
    expect(calls).toBe(1); // no nudge round-trips
  });
});

test("the plan-mode note rides the first send only", async () => {
  await withDir(async (dir) => {
    const provider: IProvider = {
      async complete() {
        return { content: "ok", toolCalls: [] };
      },
    };
    const session = await Session.create({ provider, cwd: dir });

    session.setPlanMode(true);
    await session.send("first");

    const firstUser = session.messages.find((m) => m.role === "user");

    expect(firstUser?.content).toContain("PLAN MODE");

    await session.send("second");

    // [..., user2, assistant] — the revision message goes bare.
    const lastUser = session.messages.at(-2);

    expect(lastUser?.role).toBe("user");
    expect(lastUser?.content).not.toContain("PLAN MODE");
  });
});

test("the plan-mode note asks for prioritized clarifying questions and states the greenfield detail principle", async () => {
  await withDir(async (dir) => {
    const provider: IProvider = {
      async complete() {
        return { content: "ok", toolCalls: [] };
      },
    };
    const session = await Session.create({ provider, cwd: dir });

    session.setPlanMode(true);
    await session.send("build something new");

    const note = session.messages.find((m) => m.role === "user")?.content ?? "";

    // Smart clarify: a short, prioritized set of questions (not one terse line).
    expect(note).toContain("CLARIFY");
    expect(note).toContain("At most 3-4");
    // Blunt greenfield guidance — verbatim principle the user asked for.
    expect(note).toContain("the more detail and research");
    // Still ends in the present_plan + approval contract.
    expect(note).toContain("present_plan");
    // Decomposition heuristics for execution-ready plans.
    expect(note).toContain("contracts/types");
    expect(note).toContain("1–3");
    expect(note).toMatch(/NEVER a checklist item for 'run tests/i);
  });
});

test("plan mode blocks a mutating run command but allows a read-only one", async () => {
  await withDir(async (dir) => {
    let calls = 0;
    const toolResults: string[] = [];
    const provider: IProvider = {
      async complete(messages) {
        calls += 1;
        toolResults.length = 0;
        toolResults.push(
          ...messages.filter((m) => m.role === "tool").map((m) => m.content)
        );

        if (calls === 1) {
          return {
            content: "",
            toolCalls: [
              {
                id: "1",
                name: "run",
                arguments: { command: "touch newfile.ts" },
              },
              { id: "2", name: "run", arguments: { command: "ls" } },
            ],
          };
        }

        return { content: "done exploring", toolCalls: [] };
      },
    };
    const session = await Session.create({ provider, cwd: dir });

    session.setPlanMode(true);
    await session.send("look around");

    expect(toolResults.some((t) => t.includes("read-only"))).toBe(true);
    // The `ls` ran for real (an empty dir lists nothing, but no rejection text).
    expect(toolResults.filter((t) => t.includes("read-only")).length).toBe(1);
  });
});

test("isReadOnlyCommand: allowlisted inspection passes, anything mutating fails", () => {
  // Read-only shapes.
  expect(isReadOnlyCommand("ls")).toBe(true);
  expect(isReadOnlyCommand("ls -la src")).toBe(true);
  expect(isReadOnlyCommand("pwd")).toBe(true);
  expect(isReadOnlyCommand("rg -n foo src")).toBe(true);
  expect(isReadOnlyCommand("git log --oneline")).toBe(true);
  expect(isReadOnlyCommand("git diff")).toBe(true);
  expect(isReadOnlyCommand("tsc --noEmit")).toBe(true);
  expect(isReadOnlyCommand("cat package.json")).toBe(true);
  expect(isReadOnlyCommand("node --version")).toBe(true);
  expect(isReadOnlyCommand("bun -v")).toBe(true);
  expect(isReadOnlyCommand("npm --version")).toBe(true);

  // Safe && chains of read-only segments (greenfield probes).
  expect(isReadOnlyCommand("pwd && ls -la")).toBe(true);
  expect(isReadOnlyCommand("node --version && bun --version")).toBe(true);

  // Mutation or escape hatches.
  expect(isReadOnlyCommand("rm -rf x")).toBe(false);
  expect(isReadOnlyCommand("git commit -m x")).toBe(false);
  expect(isReadOnlyCommand("git checkout .")).toBe(false);
  expect(isReadOnlyCommand("rg foo > out.txt")).toBe(false);
  expect(isReadOnlyCommand("ls && rm x")).toBe(false);
  expect(isReadOnlyCommand("cat a | tee b")).toBe(false);
  expect(isReadOnlyCommand("echo $(rm x)")).toBe(false);
  expect(isReadOnlyCommand("npm install")).toBe(false);
  expect(isReadOnlyCommand("node")).toBe(false); // bare node is a REPL
  expect(isReadOnlyCommand("")).toBe(false);

  // Allowlisted commands that MUTATE via a flag — the head/subcommand check used
  // to wave these through (Codex review). Each must now be rejected.
  expect(isReadOnlyCommand("find . -delete")).toBe(false);
  expect(isReadOnlyCommand("find . -exec rm {} +")).toBe(false);
  expect(isReadOnlyCommand("git branch -D main")).toBe(false);
  expect(isReadOnlyCommand("git branch newbranch")).toBe(false); // creates a branch
  expect(isReadOnlyCommand("tsc --outDir dist")).toBe(false);
  expect(isReadOnlyCommand("tsc")).toBe(false); // bare tsc EMITS by default
  expect(isReadOnlyCommand("tsc -p tsconfig.json --build")).toBe(false);
  // --tsBuildInfoFile / --incremental write a .tsbuildinfo even with --noEmit.
  expect(isReadOnlyCommand("tsc --noEmit --tsBuildInfoFile x")).toBe(false);
  expect(isReadOnlyCommand("tsc --noEmit --incremental")).toBe(false);

  // And the read-only shapes of those same commands still pass.
  expect(isReadOnlyCommand("find . -name '*.ts'")).toBe(true);
  expect(isReadOnlyCommand("git branch")).toBe(true); // bare list
  expect(isReadOnlyCommand("git branch -a")).toBe(true);
  expect(isReadOnlyCommand("tsc -p tsconfig.json --noEmit")).toBe(true);
  expect(isReadOnlyCommand("tsc --version")).toBe(true);
});
