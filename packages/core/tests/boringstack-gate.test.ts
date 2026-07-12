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

  test("runs with the whole repo mounted at the working root", async () => {
    let seen: string[] = [];

    const exec = async (argv: readonly string[]) => {
      seen = [...argv];

      return { code: 0, stdout: "", stderr: "" };
    };

    await runBoringstackGate("/repo", exec);
    const j = seen.join(" ");

    expect(j).toContain("apps/api && bun run validate");
    expect(j).toContain("/repo");
  });
});
