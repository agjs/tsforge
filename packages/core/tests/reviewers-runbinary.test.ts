import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  buildBinaryInvocation,
  runBinary,
  makeProvider,
} from "../src/cli/harness-review-mode";

describe("makeProvider", () => {
  test("builds a provider with a complete() method from a model entry", () => {
    const provider = makeProvider({
      baseUrl: "https://api.example.com/v1",
      model: "some-model",
    });

    expect(typeof provider.complete).toBe("function");
  });
});

describe("buildBinaryInvocation — pure invocation builder", () => {
  test("arg mode: appends stdin as last argv element", () => {
    const result = buildBinaryInvocation(
      { argv: ["reviewer", "--check"], input: "arg" },
      "request data",
      undefined
    );

    expect(result.cmd).toEqual(["reviewer", "--check", "request data"]);
    expect(result.stdinBytes).toBeUndefined();
    expect(result.tmpFile).toBeUndefined();
  });

  test("stdin mode: passes stdin as bytes, no file", () => {
    const stdin = "request data";
    const result = buildBinaryInvocation(
      { argv: ["reviewer", "--check"], input: "stdin" },
      stdin,
      undefined
    );

    expect(result.cmd).toEqual(["reviewer", "--check"]);
    expect(result.stdinBytes).toEqual(new TextEncoder().encode(stdin));
    expect(result.tmpFile).toBeUndefined();
  });

  test("tempfile mode: appends file path, returns tmpFile marker", () => {
    const tmpPath = join(tmpdir(), "test-file.txt");
    const result = buildBinaryInvocation(
      { argv: ["reviewer", "--check"], input: "tempfile" },
      "request data",
      tmpPath
    );

    expect(result.cmd).toEqual(["reviewer", "--check", tmpPath]);
    expect(result.stdinBytes).toBeUndefined();
    expect(result.tmpFile).toEqual(tmpPath);
  });
});

describe("runBinary with tempfile mode", () => {
  test("tempfile mode: writes request to file, passes path to binary, reads content", async () => {
    // Use sh to cat the file at the given path
    const result = await runBinary(
      {
        argv: ["sh", "-c", 'cat "$1"', "sh"],
        input: "tempfile",
        timeoutMs: 5000,
      },
      "test request content"
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("test request content");
  });

  test("tempfile mode: deletes the temp file after the run (no leak)", async () => {
    // The binary echoes its file-path argument ($1); after runBinary returns,
    // the finally-block cleanup must have removed that path.
    const result = await runBinary(
      {
        argv: ["sh", "-c", 'printf "%s" "$1"', "sh"],
        input: "tempfile",
        timeoutMs: 5000,
      },
      "cleanup check"
    );
    const path = result.stdout.trim();

    expect(result.ok).toBe(true);
    expect(path.length).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
  });

  test("arg mode: appends content as argument and runs command", async () => {
    // Use sh to echo the passed argument
    const result = await runBinary(
      { argv: ["sh", "-c", 'echo "$1"', "sh"], input: "arg", timeoutMs: 5000 },
      "arg mode test"
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("arg mode test");
  });

  test("stdin mode: passes content via stdin", async () => {
    // Use cat to read from stdin
    const result = await runBinary(
      { argv: ["cat"], input: "stdin", timeoutMs: 5000 },
      "stdin mode test"
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("stdin mode test");
  });
});

describe("runBinary sandboxes the reviewer's working directory", () => {
  test("the reviewer runs in a throwaway temp dir, NOT the repo/process cwd", async () => {
    const result = await runBinary(
      { argv: ["sh", "-c", "pwd"], input: "stdin", timeoutMs: 5000 },
      ""
    );
    const cwd = result.stdout.trim();

    expect(result.ok).toBe(true);
    expect(cwd.includes("tsforge-review-sandbox-")).toBe(true);
    expect(cwd).not.toBe(process.cwd());
  });

  test("a file the reviewer creates lands in the sandbox (repo untouched) and is cleaned up", async () => {
    // The exact failure this guards: an agentic reviewer writing into its CWD. If the CWD were the
    // repo, this probe file would appear in the repo root (the class of pollution that corrupted
    // main). It must land in the sandbox instead, and the sandbox must be gone after the run.
    const probeInRepo = join(process.cwd(), "reviewer-pollution-probe.txt");
    const before = existsSync(probeInRepo);

    const result = await runBinary(
      {
        argv: ["sh", "-c", "touch reviewer-pollution-probe.txt && pwd"],
        input: "stdin",
        timeoutMs: 5000,
      },
      ""
    );
    const sandbox = result.stdout.trim();

    expect(result.ok).toBe(true);
    // The repo cwd is unchanged — the probe did NOT leak into it.
    expect(existsSync(probeInRepo)).toBe(before);
    // The sandbox where it actually went is removed after the run.
    expect(existsSync(sandbox)).toBe(false);
  });
});
