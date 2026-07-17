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
    // Fast = each app's `check` (lint+typecheck+meta+knip) + the cheap API tests. The
    // API stage must still END with `check && test` (the JSON aid is inserted BEFORE it).
    expect(cmd).toContain("cd apps/api &&");
    expect(cmd).toContain("bun run check && bun run test)");
    // The UI stage regenerates the OpenAPI client first and must still RUN `check`, then
    // the feature tests — the stage ends with `&& bun run test -- run src/features)`.
    expect(cmd).toContain("cd apps/ui && bun run generate:api &&");
    expect(cmd).toContain(
      "&& bun run check && bun run test -- run src/features)"
    );
    // The slow acceptance-only work must NOT be in the per-cycle gate.
    expect(cmd).not.toContain("bun run validate");
    // App markers for repo-relative path attribution (knip).
    expect(cmd).toContain("::tsforge-app apps/api::");
    // Each app emits its eslint as STRUCTURED JSON (via its own lint script) so the
    // failure parser reads exact {file,line,rule,message} instead of stylish text.
    // BOTH apps must emit; the UI marker must sit inside the UI stage (after generate:api).
    expect(cmd).toContain("::tsforge-eslint-json apps/api::");
    expect(cmd).toContain("::tsforge-eslint-json apps/ui::");
    expect(cmd.indexOf("::tsforge-eslint-json apps/ui::")).toBeGreaterThan(
      cmd.indexOf("cd apps/ui && bun run generate:api")
    );
    expect(cmd).toContain("bun run --silent lint -- --format json");
    // The UI stage now runs the feature test suite too (gate parity with acceptance) —
    // a UI test that lints/typechecks but fails at runtime (vi.mock hoisting) must fail
    // the FAST gate, not only the full acceptance gate.
    expect(cmd).toContain("bun run test -- run src/features");
    expect(cmd.indexOf("bun run test -- run src/features")).toBeGreaterThan(
      cmd.indexOf("cd apps/ui")
    );
  });

  test("FULL gate runs the complete validate + build + size + root check (final acceptance)", async () => {
    const { cmd } = await cmdFor("full");

    // Both apps must still RUN validate (the JSON aid is inserted before it). Slice from
    // each stage's `cd` so a dropped validate in EITHER stage fails the assertion.
    expect(cmd).toContain("cd apps/api &&");
    expect(cmd).toContain("cd apps/ui && bun run generate:api &&");
    const apiStage = cmd.slice(
      cmd.indexOf("cd apps/api"),
      cmd.indexOf("cd apps/ui")
    );
    const uiStage = cmd.slice(cmd.indexOf("cd apps/ui"));

    expect(apiStage).toContain("bun run validate");
    expect(uiStage).toContain("bun run validate");
    // The repo-root drift/build check only runs in the full gate.
    expect(cmd).toContain("::tsforge-app .::");
    expect(cmd).toContain("bun run check");
    // Structured eslint JSON is emitted for BOTH apps in the full gate too.
    expect(cmd).toContain("::tsforge-eslint-json apps/api::");
    expect(cmd).toContain("::tsforge-eslint-json apps/ui::");
  });
});
