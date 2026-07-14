import { describe, expect, test } from "bun:test";
import { parseHeadlessArgs } from "../scripts/headless-build";

describe("parseHeadlessArgs", () => {
  test("parses prompt and dir from positional arguments", () => {
    const result = parseHeadlessArgs(["build x", "/clone"]);

    expect(result.prompt).toBe("build x");
    expect(result.dir).toBe("/clone");
    expect(result.planPath).toBeUndefined();
    expect(result.logFile).toBeUndefined();
  });

  test("parses --log-file flag", () => {
    const result = parseHeadlessArgs([
      "goal",
      "/clone",
      "--log-file",
      "/tmp/output.jsonl",
    ]);

    expect(result.prompt).toBe("goal");
    expect(result.dir).toBe("/clone");
    expect(result.logFile).toBe("/tmp/output.jsonl");
  });

  test("parses --plan flag", () => {
    const result = parseHeadlessArgs([
      "goal",
      "/clone",
      "--plan",
      "/path/to/plan.md",
    ]);

    expect(result.prompt).toBe("goal");
    expect(result.dir).toBe("/clone");
    expect(result.planPath).toBe("/path/to/plan.md");
  });

  test("parses --plan and --log-file together", () => {
    const result = parseHeadlessArgs([
      "goal",
      "/clone",
      "--plan",
      "/path/plan.md",
      "--log-file",
      "/tmp/log.jsonl",
    ]);

    expect(result.prompt).toBe("goal");
    expect(result.dir).toBe("/clone");
    expect(result.planPath).toBe("/path/plan.md");
    expect(result.logFile).toBe("/tmp/log.jsonl");
  });

  test("returns undefined for prompt when not provided", () => {
    const result = parseHeadlessArgs([]);

    expect(result.prompt).toBeUndefined();
    expect(result.dir).toBeUndefined();
  });

  test("returns undefined for dir when only prompt provided", () => {
    const result = parseHeadlessArgs(["goal"]);

    expect(result.prompt).toBe("goal");
    expect(result.dir).toBeUndefined();
  });
});
