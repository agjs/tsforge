import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import {
  parseAgentSpec,
  unrecognizedAgentKeys,
} from "../src/config/agent-specs";

// Pure agent-SPEC config tests (parse + load). Split out of agent-runner.test.ts (#63): those tests
// construct AgentRunner against the real repo and need a raised per-file timeout, but these do not —
// keeping them here preserves bun's 5s fail-fast default for this fast, hermetic config suite.

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
