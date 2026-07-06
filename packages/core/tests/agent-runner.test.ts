import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IProvider, IModelResponse } from "../src/inference";
import { AgentRunner, AGENT_LIMITS } from "../src/agent/agent-runner";
import {
  parseAgentSpec,
  unrecognizedAgentKeys,
} from "../src/config/agent-specs";

/** A provider that replays a fixed queue of responses (repeats the last one). */
function scripted(queue: IModelResponse[]): {
  provider: IProvider;
  seenTools: () => string[];
} {
  let toolNames: string[] = [];
  let i = 0;

  return {
    provider: {
      complete(_messages, opts) {
        const raw = opts?.tools ?? [];

        toolNames = raw.flatMap((t) =>
          typeof t === "object" &&
          t !== null &&
          "function" in t &&
          typeof t.function === "object" &&
          t.function !== null &&
          "name" in t.function &&
          typeof t.function.name === "string"
            ? [t.function.name]
            : []
        );

        const res = queue[Math.min(i, queue.length - 1)];

        i += 1;

        if (res === undefined) {
          throw new Error("scripted queue is empty");
        }

        return Promise.resolve(res);
      },
    },
    seenTools: () => toolNames,
  };
}

// The tsforge repo itself is the read-only workspace under test.
const REPO = join(import.meta.dir, "..", "..", "..");

describe("parseAgentSpec", () => {
  test("accepts a well-formed spec and keeps only valid fields", () => {
    const spec = parseAgentSpec({
      id: "explore",
      description: "map a subsystem",
      model: "qwen3-coder",
      kind: "chat",
      tools: ["read", "search", 42],
      maxTurns: 6,
      outputMode: "structured",
      bogus: true,
    });

    expect(spec?.id).toBe("explore");
    expect(spec?.tools).toEqual(["read", "search"]);
    expect(spec?.maxTurns).toBe(6);
    expect(spec?.outputMode).toBe("structured");
    expect(unrecognizedAgentKeys({ id: "x", bogus: true })).toEqual(["bogus"]);
  });

  test("rejects a missing/non-kebab id and drops invalid enums", () => {
    expect(parseAgentSpec({ model: "m" })).toBeNull();
    expect(parseAgentSpec({ id: "Has Space" })).toBeNull();
    expect(parseAgentSpec({ id: "x", kind: "psychic" })?.kind).toBeUndefined();
    expect(
      parseAgentSpec({ id: "x", outputMode: "yaml" })?.outputMode
    ).toBeUndefined();
  });
});

describe("AgentRunner (read-only loop against this repo)", () => {
  test("tool turn then final text; events are agentId-tagged", async () => {
    const { provider } = scripted([
      {
        content: "",
        toolCalls: [
          { id: "1", name: "read", arguments: { file: "package.json" } },
        ],
      },
      { content: "The package is @agjs/tsforge.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({ id: "explore" });
    const result = await runner.run({
      provider,
      cwd: REPO,
      parentTaskId: "run-1",
      task: "What package is this?",
    });

    expect(result.status).toBe("done");
    expect(result.output).toContain("@agjs/tsforge");
    expect(result.turns).toBe(2);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((e) => e.agentId === "run-1:explore")).toBe(
      true
    );
    expect(result.events.every((e) => e.parentTask === "run-1")).toBe(true);
  });

  test("mutating tools are neither advertised nor executable", async () => {
    const target = join(REPO, "SHOULD_NEVER_EXIST.ts");
    const { provider, seenTools } = scripted([
      {
        content: "",
        toolCalls: [
          {
            id: "1",
            name: "create",
            arguments: { file: "SHOULD_NEVER_EXIST.ts", content: "x" },
          },
        ],
      },
      { content: "done", toolCalls: [] },
    ]);
    const result = await new AgentRunner({ id: "explore" }).run({
      provider,
      cwd: REPO,
      parentTaskId: "run-1",
      task: "try to write",
    });

    // Layer 1: create/edit/run never advertised.
    expect(seenTools()).not.toContain("create");
    expect(seenTools()).not.toContain("edit_lines");
    expect(seenTools()).toContain("read");
    // Layer 2: the forced call was rejected at dispatch — nothing on disk.
    expect(existsSync(target)).toBe(false);
    expect(result.status).toBe("done");
  });

  test("spec.tools narrows the advertised read-only set", async () => {
    const { provider, seenTools } = scripted([
      { content: "ok", toolCalls: [] },
    ]);

    await new AgentRunner({ id: "narrow", tools: ["read"] }).run({
      provider,
      cwd: REPO,
      parentTaskId: "r",
      task: "t",
    });

    expect(seenTools()).toEqual(["read"]);
  });

  test("maxTurns caps a tool-looping agent", async () => {
    const { provider } = scripted([
      {
        content: "",
        toolCalls: [
          { id: "1", name: "read", arguments: { file: "package.json" } },
        ],
      },
    ]);
    const result = await new AgentRunner({ id: "loopy", maxTurns: 3 }).run({
      provider,
      cwd: REPO,
      parentTaskId: "r",
      task: "loop forever",
    });

    expect(result.status).toBe("max_turns");
    expect(result.turns).toBe(3);
    expect(AGENT_LIMITS.maxTurns).toBeGreaterThan(0);
  });

  test("structured mode: prose gets nudged, agent_result delivers the payload", async () => {
    const { provider, seenTools } = scripted([
      { content: "here is my answer in prose", toolCalls: [] },
      {
        content: "",
        toolCalls: [
          {
            id: "1",
            name: "agent_result",
            arguments: { result: "structured-answer" },
          },
        ],
      },
    ]);
    const result = await new AgentRunner({
      id: "structured",
      outputMode: "structured",
    }).run({ provider, cwd: REPO, parentTaskId: "r", task: "t" });

    expect(seenTools()).toContain("agent_result");
    expect(result.status).toBe("done");
    expect(result.output).toBe("structured-answer");
    expect(result.turns).toBe(2);
  });

  test("generate kind is rejected until Phase D", async () => {
    const { provider } = scripted([{ content: "", toolCalls: [] }]);
    const result = await new AgentRunner({ id: "img", kind: "generate" }).run({
      provider,
      cwd: REPO,
      parentTaskId: "r",
    });

    expect(result.status).toBe("error");
    expect(result.output).toContain("generate");
  });
});

describe("loadAgentSpecs", () => {
  test("project spec overrides global on id collision", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { loadAgentSpecs } = await import("../src/config/agent-specs");
    const home = await mkdtemp(join(tmpdir(), "tsforge-agents-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "tsforge-agents-proj-"));
    const prev = process.env.TSFORGE_HOME;

    try {
      process.env.TSFORGE_HOME = home;
      await mkdir(join(home, ".tsforge", "agents"), { recursive: true });
      await mkdir(join(cwd, ".tsforge", "agents"), { recursive: true });
      await writeFile(
        join(home, ".tsforge/agents/explore.json"),
        JSON.stringify({ id: "explore", model: "global-model" })
      );
      await writeFile(
        join(cwd, ".tsforge/agents/explore.json"),
        JSON.stringify({ id: "explore", model: "project-model", bogus: 1 })
      );
      await writeFile(join(cwd, ".tsforge/agents/broken.json"), "{ nope");

      const reports: string[] = [];
      const specs = await loadAgentSpecs(cwd, (m) => reports.push(m));

      expect(specs.map((s) => s.id)).toEqual(["explore"]);
      expect(specs[0]?.model).toBe("project-model");
      expect(reports.some((m) => m.includes("broken.json"))).toBe(true);
      expect(reports.some((m) => m.includes("bogus"))).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.TSFORGE_HOME;
      } else {
        process.env.TSFORGE_HOME = prev;
      }

      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
