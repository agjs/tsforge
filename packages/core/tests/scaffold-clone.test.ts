import { describe, expect, test } from "bun:test";
import { cloneRepo, scaffoldRecord } from "../src/scaffold/clone";
import type { IScaffoldRunner } from "../src/scaffold/io";
import type { IShellRun } from "../src/lib/fs/process";

function ok(stdout = ""): IShellRun {
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
}

/** A runner that records every invocation and replies from a per-command script. */
function recorder(reply: (argv: readonly string[]) => IShellRun = () => ok()): {
  run: IScaffoldRunner;
  calls: { cwd: string; argv: readonly string[] }[];
} {
  const calls: { cwd: string; argv: readonly string[] }[] = [];

  const run: IScaffoldRunner = (cwd, argv) => {
    calls.push({ cwd, argv });

    return Promise.resolve(reply(argv));
  };

  return { run, calls };
}

describe("cloneRepo", () => {
  test("shallow-clones the ref and resolves HEAD to a sha", async () => {
    const sha = "c643a0e1234567890abcdef1234567890abcdef0";
    const { run, calls } = recorder((argv) =>
      argv[1] === "rev-parse" ? ok(`${sha}\n`) : ok()
    );

    const result = await cloneRepo(
      "https://github.com/boringstack-xyz/boringstack",
      "main",
      "/tmp/proj",
      run
    );

    expect(result).toEqual({ dir: "/tmp/proj", resolvedSha: sha });

    const clone = calls[0]?.argv ?? [];

    expect(clone[0]).toBe("git");
    expect(clone).toContain("clone");
    expect(clone).toContain("--depth");
    expect(clone).toContain("main"); // the ref
    expect(clone.at(-2)).toBe("https://github.com/boringstack-xyz/boringstack");
    expect(clone.at(-1)).toBe("/tmp/proj");

    // rev-parse runs INSIDE the cloned dir
    expect(calls[1]?.cwd).toBe("/tmp/proj");
    expect(calls[1]?.argv).toEqual(["git", "rev-parse", "HEAD"]);
  });

  test("throws with stderr when the clone fails (no silent half-scaffold)", async () => {
    const { run } = recorder((argv) =>
      argv.includes("clone")
        ? {
            stdout: "",
            stderr: "fatal: repository not found",
            exitCode: 128,
            timedOut: false,
          }
        : ok()
    );

    await expect(
      cloneRepo("https://example.com/nope", "main", "/tmp/x", run)
    ).rejects.toThrow(/repository not found/u);
  });
});

describe("scaffoldRecord", () => {
  test("captures the replay metadata (source, ref, sha, archetype, version)", () => {
    const record = scaffoldRecord({
      source: "https://github.com/boringstack-xyz/boringstack",
      ref: "main",
      resolvedSha: "abc123",
      archetype: "boringstack",
      manifestVersion: 1,
    });

    expect(record).toEqual({
      source: "https://github.com/boringstack-xyz/boringstack",
      ref: "main",
      resolvedSha: "abc123",
      archetype: "boringstack",
      manifestVersion: 1,
    });
  });
});
