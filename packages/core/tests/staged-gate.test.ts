import { test, expect, describe } from "bun:test";
import { join } from "node:path";

// Resolve relative to THIS file, not process.cwd() — the suite must pass no
// matter which directory bun test is launched from (repo root or packages/core).
const STAGED_GATE = join(import.meta.dir, "..", "scripts", "staged-gate.ts");

interface IStage {
  label: string;
  command: string;
}

/** Run the staged-gate script with a base64 payload of `stages`; return its merged
 *  output + exit code (mirrors how the gate runner captures it). */
async function runStaged(
  stages: readonly IStage[]
): Promise<{ output: string; exitCode: number }> {
  const payload = Buffer.from(JSON.stringify(stages)).toString("base64");
  const proc = Bun.spawn(["bun", STAGED_GATE, payload], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { output: out + err, exitCode };
}

describe("staged-gate", () => {
  test("all stages pass ⇒ exit 0 with per-stage banners", async () => {
    const { output, exitCode } = await runStaged([
      { label: "first", command: "echo one" },
      { label: "second", command: "echo two" },
    ]);

    expect(exitCode).toBe(0);
    expect(output).toContain("━━ first ━━");
    expect(output).toContain("━━ second ━━");
    expect(output).toContain("one");
    expect(output).toContain("two");
    expect(output).toContain("✓ all gate stages passed");
  });

  test("first failing stage names itself and STOPS (later stages skipped)", async () => {
    const { output, exitCode } = await runStaged([
      { label: "ok", command: "echo good" },
      { label: "boom", command: "echo failing >&2; exit 3" },
      { label: "never", command: "echo should-not-run" },
    ]);

    expect(exitCode).toBe(3); // the failing stage's exit code is preserved
    expect(output).toContain("━━ boom ━━");
    expect(output).toContain("✗ boom FAILED (exit 3)");
    // The stage AFTER the failure must not run.
    expect(output).not.toContain("should-not-run");
    expect(output).not.toContain("━━ never ━━");
  });

  test("a stage's stderr is forwarded (so the gate parser sees errors)", async () => {
    const { output } = await runStaged([
      { label: "noisy", command: "echo to-stderr >&2; exit 1" },
    ]);

    expect(output).toContain("to-stderr");
  });

  test("a malformed payload fails loudly (exit 2), never silently no-ops", async () => {
    const proc = Bun.spawn(["bun", STAGED_GATE, "not-valid-base64-json!!"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
  });
});
