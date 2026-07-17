import { test, expect, describe } from "bun:test";
import { runBoringstackGate } from "../src/loop/boringstack/gate";

describe("runBoringstackGate", () => {
  test("passes on exit 0", async () => {
    const exec = async () => ({ code: 0, stdout: "ok", stderr: "" });

    expect((await runBoringstackGate("/repo", exec)).passed).toBe(true);
  });

  test("fails and surfaces output on non-zero", async () => {
    const exec = async () => ({
      code: 1,
      stdout: "✗ typecheck FAILED",
      stderr: "",
    });
    const r = await runBoringstackGate("/repo", exec);

    expect(r.passed).toBe(false);
    expect(r.output).toContain("typecheck");
  });

  const cmdFor = async (
    mode?: "fast" | "full"
  ): Promise<{ cmd: string; cwd: string }> => {
    let seen: readonly string[] = [];
    let seenCwd = "";

    const exec = async (argv: readonly string[], opts: { cwd: string }) => {
      seen = [...argv];
      seenCwd = opts.cwd;

      return { code: 0, stdout: "", stderr: "" };
    };

    await runBoringstackGate("/repo", exec, mode);

    return { cmd: seen.join(" "), cwd: seenCwd };
  };

  test("FAST gate (default) runs per-app `check` + API tests — NOT build/size/coverage", async () => {
    const { cmd, cwd } = await cmdFor();

    // Host shell in the clone, never docker.
    expect(cmd.startsWith("bash")).toBe(true);
    expect(cmd).not.toContain("docker");
    expect(cwd).toBe("/repo");
    // Fast = each app's `check` (lint+typecheck+meta+knip) + the cheap API tests.
    expect(cmd).toContain("bun run check && bun run test");
    // UI regenerates the OpenAPI client first, then `check` (no build/size per cycle).
    expect(cmd).toContain("apps/ui && bun run generate:api");
    // The slow acceptance-only work must NOT be in the per-cycle gate.
    expect(cmd).not.toContain("bun run validate");
    // App markers for repo-relative path attribution (knip).
    expect(cmd).toContain("::tsforge-app apps/api::");
    // Each app emits its eslint as STRUCTURED JSON (via its own lint script) so the
    // failure parser reads exact {file,line,rule,message} instead of stylish text.
    // BOTH apps must emit — per-app coverage means a missing UI block silently drops
    // to stylish, so assert the UI marker is present (inside the UI stage) too.
    expect(cmd).toContain("::tsforge-eslint-json apps/api::");
    expect(cmd).toContain("::tsforge-eslint-json apps/ui::");
    expect(cmd).toContain("apps/ui && bun run generate:api");
    expect(cmd.indexOf("::tsforge-eslint-json apps/ui::")).toBeGreaterThan(
      cmd.indexOf("apps/ui && bun run generate:api")
    );
    expect(cmd).toContain("bun run --silent lint -- --format json");
  });

  test("FULL gate runs the complete validate + build + size + root check (final acceptance)", async () => {
    const { cmd } = await cmdFor("full");

    expect(cmd).toContain("bun run validate");
    expect(cmd).toContain("apps/ui && bun run generate:api");
    // The repo-root drift/build check only runs in the full gate.
    expect(cmd).toContain("::tsforge-app .::");
    expect(cmd).toContain("bun run check");
    // Structured eslint JSON is emitted for BOTH apps in the full gate too.
    expect(cmd).toContain("::tsforge-eslint-json apps/api::");
    expect(cmd).toContain("::tsforge-eslint-json apps/ui::");
  });
});
