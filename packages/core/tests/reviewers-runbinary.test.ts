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
