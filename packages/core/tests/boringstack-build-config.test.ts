import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { BORINGSTACK_BUILD_SESSION } from "../src/loop/boringstack/build-config";
import { createBoringstackHostSession } from "../src/loop/boringstack/build-session";
import { isRecord } from "../src/lib/guards/guards";

// createBoringstackHostSession is the SINGLE constructor the headless driver uses, so
// asserting the session it builds actually advertises `check` closes the real gap:
// dropping offerCheck from the flags — or bypassing the constructor — regresses here.

test("the BoringStack build flags keep offerCheck + convention library + drive-to-green", () => {
  expect(BORINGSTACK_BUILD_SESSION.offerCheck).toBe(true);
  expect(BORINGSTACK_BUILD_SESSION.pullConventions).toBe(true);
  expect(BORINGSTACK_BUILD_SESSION.executionMode).toBe("drive-to-green");
});

test("the boringstack host session actually ADVERTISES check to the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-hostcfg-"));
  const captured = { names: [] as string[] };

  const provider: IProvider = {
    async complete(_messages, opts) {
      const tools = Array.isArray(opts?.tools) ? opts.tools : [];

      captured.names = tools.flatMap((t) => {
        if (!isRecord(t) || !isRecord(t.function)) {
          return [];
        }

        return typeof t.function.name === "string" ? [t.function.name] : [];
      });

      return { content: "done", toolCalls: [] };
    },
  };

  try {
    const host = await createBoringstackHostSession({
      provider,
      cwd: dir,
      contextWindow: 8000,
      maxTurns: 1,
      report: () => undefined,
      editGuard: () => null,
    });

    await host.send("go");

    expect(captured.names).toContain("check");
    // Sibling flags travel with it — a regression in any is visible here too.
    expect(captured.names).toContain("pull_conventions");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
