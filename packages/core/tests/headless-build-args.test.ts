import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHeadlessArgs,
  resolveWorkspaceDir,
} from "../scripts/headless-build";

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

describe("resolveWorkspaceDir", () => {
  test("resolves a symlinked clone dir to its real path (so gate paths match cwd)", async () => {
    const base = await mkdtemp(join(tmpdir(), "hb-real-"));

    try {
      const real = join(base, "real-clone");
      const link = join(base, "link-clone");

      await mkdir(real, { recursive: true });
      await symlink(real, link);

      // The symlink resolves to the real dir — this is the macOS /tmp→/private/tmp
      // class of mismatch that mangled gate paths and falsely "locked" files.
      expect(await realpath(link)).toBe(await realpath(real));
      expect(resolveWorkspaceDir(link)).toBe(await realpath(real));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("returns a non-existent dir unchanged (the apps/api check reports it later)", () => {
    const missing = join(tmpdir(), "hb-does-not-exist-xyz-12345");

    expect(resolveWorkspaceDir(missing)).toBe(missing);
  });
});
