import { test, expect, describe, setDefaultTimeout } from "bun:test";
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

// #63: every test here constructs `new AgentRunner(...).run({ cwd: REPO })`, which pays a fixed
// ~2s startup cost against the real repo (even the immediate-abort / no-op cases). In isolation the
// file runs ~1.9s/test — well under bun's 5000ms default — but under the FULL suite's 273-file
// concurrency, CPU contention inflates that startup past 5s and the tests spuriously time out,
// which false-BLOCKs the harness-review pre-validate gate. Raise the ceiling for THIS FILE ONLY
// (setDefaultTimeout is module-scoped) so the 5s fail-fast default — and its infinite-loop
// detection — stays intact for the other 272 files. 15s = generous margin over the real ~2s work
// under contention, while still failing a genuine hang here.
setDefaultTimeout(15_000);

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

    // Layer 1: create/edit/run never advertised — nor spawn_agent, so a subagent
    // structurally cannot delegate (recursion depth capped at 1).
    expect(seenTools()).not.toContain("create");
    expect(seenTools()).not.toContain("edit_lines");
    expect(seenTools()).not.toContain("spawn_agent");
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

  test("structured mode: agent_result before investigating is rejected, accepted after a real tool call", async () => {
    const { provider, seenTools } = scripted([
      // Turn 1: tries to answer immediately. `agent_result` alone satisfies
      // toolChoice:"required", but with real tools available and no investigation
      // yet it MUST be rejected (else a structured agent answers from memory).
      {
        content: "",
        toolCalls: [
          { id: "1", name: "agent_result", arguments: { result: "premature" } },
        ],
      },
      // Turn 2: forced to actually investigate.
      {
        content: "",
        toolCalls: [
          { id: "2", name: "read", arguments: { file: "package.json" } },
        ],
      },
      // Turn 3: now the result is accepted.
      {
        content: "",
        toolCalls: [
          { id: "3", name: "agent_result", arguments: { result: "grounded" } },
        ],
      },
    ]);
    const result = await new AgentRunner({
      id: "structured",
      outputMode: "structured",
    }).run({ provider, cwd: REPO, parentTaskId: "r", task: "t" });

    expect(seenTools()).toContain("agent_result");
    expect(result.status).toBe("done");
    // The premature turn-1 answer was NOT accepted; the grounded one (after a
    // real read) was.
    expect(result.output).toBe("grounded");
    expect(result.turns).toBe(3);
  });

  test("structured agent with NO real tools accepts agent_result immediately", async () => {
    const { provider } = scripted([
      {
        content: "",
        toolCalls: [
          { id: "1", name: "agent_result", arguments: { result: "answer" } },
        ],
      },
    ]);
    // `tools: []` ⇒ the only advertised tool is agent_result, so there's nothing
    // to investigate WITH — the investigation gate must not deadlock it.
    const result = await new AgentRunner({
      id: "structured",
      outputMode: "structured",
      tools: [],
    }).run({ provider, cwd: REPO, parentTaskId: "r", task: "t" });

    expect(result.status).toBe("done");
    expect(result.output).toBe("answer");
    expect(result.turns).toBe(1);
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
      const ids = specs.map((s) => s.id);

      // The user's project `explore.json` overrides BOTH the global one and the
      // built-in of the same id (project wins; built-in < global < project).
      expect(ids).toContain("explore");
      expect(specs.find((s) => s.id === "explore")?.model).toBe(
        "project-model"
      );
      // Built-in specialists are always present (delegation works out of the box).
      expect(ids).toContain("research");
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

describe("review-round regressions", () => {
  test("project policy rules apply inside the agent (deny read)", async () => {
    const { provider } = scripted([
      {
        content: "",
        toolCalls: [
          { id: "1", name: "read", arguments: { file: "package.json" } },
        ],
      },
      { content: "blocked, giving up", toolCalls: [] },
    ]);
    const result = await new AgentRunner({ id: "explore" }).run({
      provider,
      cwd: REPO,
      parentTaskId: "r",
      task: "read the manifest",
      policyMode: "default",
      policyRules: { deny: [{ toolName: "read" }] },
    });

    // The deny rule fired at dispatch: a rejection event, no file content.
    expect(
      result.events.some((e) => e.message.startsWith("tool_rejected"))
    ).toBe(true);
    expect(result.status).toBe("done");
  });

  test("mid-request abort reports aborted + the true turn count", async () => {
    const ctrl = new AbortController();
    const aborting: IProvider = {
      complete() {
        ctrl.abort();

        const err = new Error("The operation was aborted.");

        err.name = "AbortError";

        return Promise.reject(err);
      },
    };
    const result = await new AgentRunner({ id: "explore" }).run({
      provider: aborting,
      cwd: REPO,
      parentTaskId: "r",
      task: "t",
      signal: ctrl.signal,
    });

    expect(result.status).toBe("aborted");
    expect(result.turns).toBe(1); // not maxTurns
  });

  test("tools: [] means NO tools, not the full read-only set", async () => {
    const { parseAgentSpec: parse } = await import("../src/config/agent-specs");

    expect(parse({ id: "x", tools: [] })?.tools).toEqual([]);

    const { provider, seenTools } = scripted([
      { content: "ok", toolCalls: [] },
    ]);

    await new AgentRunner({ id: "bare", tools: [] }).run({
      provider,
      cwd: REPO,
      parentTaskId: "r",
      task: "t",
    });

    expect(seenTools()).toEqual([]);
  });

  test("a throwing caller reporter cannot kill the run", async () => {
    const { provider } = scripted([{ content: "fine", toolCalls: [] }]);
    const result = await new AgentRunner({ id: "x" }).run({
      provider,
      cwd: REPO,
      parentTaskId: "r",
      task: "t",
      report: () => {
        throw new Error("consumer bug");
      },
    });

    expect(result.status).toBe("done");
    expect(result.output).toBe("fine");
  });
});
