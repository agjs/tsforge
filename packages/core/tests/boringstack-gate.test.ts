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

  test("runs the composed gate on disk in the clone (not in a container)", async () => {
    let seen: readonly string[] = [];
    let seenCwd = "";

    const exec = async (argv: readonly string[], opts: { cwd: string }) => {
      seen = [...argv];
      seenCwd = opts.cwd;

      return { code: 0, stdout: "", stderr: "" };
    };

    await runBoringstackGate("/repo", exec);
    const j = seen.join(" ");

    // Host shell, not `docker run` — deps live on disk after install.
    expect(seen[0]).toBe("bash");
    expect(j).not.toContain("docker");
    // The composed gate spans both apps + the repo-root check.
    expect(j).toContain("apps/api && bun run validate");
    // The UI stage regenerates the typed OpenAPI client from the live API BEFORE it
    // validates, so the UI never validates against a stale schema.d.ts.
    expect(j).toContain("apps/ui && bun run generate:api && bun run validate");
    expect(j).toContain("bun run check");
    // App markers let the failure parser attribute app-relative paths (knip) back to
    // repo-relative so they match the model's editable scope.
    expect(j).toContain("::tsforge-app apps/api::");
    // Runs with the clone as cwd (repo root visible to meta-rules).
    expect(seenCwd).toBe("/repo");
  });
});
