import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { BORINGSTACK_BUILD_SESSION } from "../src/loop/boringstack/build-config";
import { createBoringstackHostSession } from "../src/loop/boringstack/build-session";
import { isRecord } from "../src/lib/guards/guards";
import { classifyAction, evaluatePolicy } from "../src/policy";
import type { IPolicyContext } from "../src/policy";

// The headless driver must construct its host session THROUGH the tested constructor,
// or the whole offerCheck wiring is untested — reverting to an inline Session.create
// (with or without offerCheck) would leave the behavioral tests below green. This
// source guard fails on exactly that revert.
test("headless-build.ts wires its host session via createBoringstackHostSession, not an inline Session.create", async () => {
  const src = await Bun.file(
    join(import.meta.dir, "..", "scripts", "headless-build.ts")
  ).text();

  expect(src).toContain("createBoringstackHostSession({");
  // A re-inlined host session (the exact regression) would reintroduce Session.create.
  expect(src).not.toContain("Session.create(");
});

// createBoringstackHostSession is the SINGLE constructor the headless driver uses, so
// asserting the session it builds actually advertises `check` closes the real gap:
// dropping offerCheck from the flags — or bypassing the constructor — regresses here.

test("the BoringStack build flags keep offerCheck + convention library + drive-to-green", () => {
  expect(BORINGSTACK_BUILD_SESSION.offerCheck).toBe(true);
  expect(BORINGSTACK_BUILD_SESSION.pullConventions).toBe(true);
  expect(BORINGSTACK_BUILD_SESSION.executionMode).toBe("drive-to-green");
});

test("the BoringStack build DENIES the model from running the browser E2E / host dev server, but ALLOWS the gate", () => {
  const rules = BORINGSTACK_BUILD_SESSION.policyRules;
  const ctx: IPolicyContext = {
    mode: "default",
    cwd: "/x",
    files: ["**/*"],
    interactive: false,
    rules,
  };
  const decide = (command: string): string =>
    evaluatePolicy(
      classifyAction({ id: "1", name: "run", arguments: { command } }, "/x"),
      ctx
    ).decision;

  // The commands that trip the host preflight guard and park a green feature — all DENIED,
  // in every invocation form the model reached for (build22–24).
  expect(decide("cd apps/ui && npx playwright test")).toBe("deny");
  expect(decide("bunx playwright test --reporter=list")).toBe("deny");
  expect(decide("bun run dev")).toBe("deny");
  expect(decide("bunx vite")).toBe("deny");
  expect(decide("./scripts/dev/preflight-host-dev.sh && vite")).toBe("deny");
  // The legitimate gate + test commands MUST still be allowed (the deny is surgical).
  expect(decide("bun run check")).toBe("allow");
  expect(decide("bun test packages")).toBe("allow");
});

test("the boringstack host session actually ADVERTISES check to the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-hostcfg-"));
  const captured: { names: string[] } = { names: [] };

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
