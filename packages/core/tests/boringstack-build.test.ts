import { test, expect, describe } from "bun:test";
import type { Exec } from "../src/loop/boringstack/exec";
import { boringstackDeps } from "../src/loop/boringstack/build";
import type { IProvider } from "../src/inference";

function feature(id: string) {
  return { id, desc: `Build ${id} resource`, passes: false, attempts: 0 };
}

function state() {
  return { goal: "build API resources", features: [] };
}

function createHost() {
  const scopes: string[][] = [];
  const sent: string[] = [];

  return {
    scopes,
    sent,
    setScope: (g: string[]) => {
      scopes.push(g);
    },
    send: async (m: string) => {
      sent.push(m);

      return { status: "done", turns: 1 };
    },
  };
}

function createExec(gateCode = 0): Exec {
  return async (_argv, _opts) => ({
    code: gateCode,
    stdout: gateCode === 0 ? "build passed" : "",
    stderr: gateCode === 0 ? "" : "build failed",
  });
}

function createEvaluator(): IProvider {
  return {
    complete: async () => ({
      content: '{"pass":true,"notes":"quality approved"}',
      toolCalls: [],
    }),
  };
}

describe("boringstackDeps.implement", () => {
  test("calls injected generate with feature id, then freezes scope and sends refine prompt", async () => {
    const host = createHost();
    const exec = createExec();
    const evaluator = createEvaluator();
    const generateCalls: { cwd: string; name: string }[] = [];
    const uiCalls: { cwd: string; name: string }[] = [];

    const generate = async (cwd: string, name: string) => {
      generateCalls.push({ cwd, name });
    };

    const generateUi = async (cwd: string, name: string) => {
      uiCalls.push({ cwd, name });
    };

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec,
      evaluator,
      generate,
      generateUi,
    });

    await deps.implement(feature("Invoice"), state());

    // Full vertical slice: API resource THEN UI feature (which syncs generate:api).
    expect(generateCalls.length).toBe(1);
    expect(generateCalls[0]?.name).toBe("Invoice");
    expect(generateCalls[0]?.cwd).toBe("/repo");
    expect(uiCalls.length).toBe(1);
    expect(uiCalls[0]?.name).toBe("Invoice");
    expect(host.scopes.length).toBe(1);
    expect(host.scopes[0]).toContain("apps/api/src/api/invoice/**");
    expect(host.sent.length).toBe(1);
    expect(host.sent[0]).toContain("Invoice");
  });

  test("auto-formats both apps with pinned prettier after the model writes", async () => {
    const host = createHost();
    const execCalls: { argv: string[]; cwd: string }[] = [];

    const exec: Exec = async (argv, opts) => {
      execCalls.push({ argv: [...argv], cwd: opts.cwd });

      return { code: 0, stdout: "", stderr: "" };
    };

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec,
      evaluator: createEvaluator(),
      generate: async () => undefined,
      generateUi: async () => undefined,
    });

    await deps.implement(feature("Invoice"), state());

    const formats = execCalls
      .filter((c) => c.argv.join(" ") === "bun run format")
      .map((c) => c.cwd)
      .sort();

    expect(formats).toEqual(["/repo/apps/api", "/repo/apps/ui"]);
  });

  test("uses default generateResource when generate not injected", async () => {
    const host = createHost();
    const exec = createExec();
    const evaluator = createEvaluator();

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec,
      evaluator,
    });

    // Just verify it has the implement method and correct signature
    expect(typeof deps.implement).toBe("function");
  });
});

describe("boringstackDeps.evaluate", () => {
  test("returns passed verdict when gate passes", async () => {
    const host = createHost();
    const exec = createExec(0);
    const evaluator = createEvaluator();

    const generate = async () => {};

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec,
      evaluator,
      generate,
    });

    const verdict = await deps.evaluate(feature("Invoice"), state());

    expect(verdict.passed).toBe(true);
  });

  test("returns failed verdict when gate fails", async () => {
    const host = createHost();
    const exec = createExec(1);
    const evaluator = createEvaluator();

    const generate = async () => {};

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec,
      evaluator,
      generate,
    });

    const verdict = await deps.evaluate(feature("Invoice"), state());

    expect(verdict.passed).toBe(false);
    expect(verdict.stage).toBe("gate");
  });

  test("differential gate PASSES when a red gate has only baseline failures", async () => {
    const host = createHost();
    // Gate exits non-zero but the only failure is a pre-existing baseline one.
    const exec: Exec = async () => ({
      code: 1,
      stdout: "(fail) validateEnv > rejects placeholder domain\n 1 fail\n",
      stderr: "",
    });

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec,
      evaluator: createEvaluator(),
      generate: async () => undefined,
      baseline: new Set(["(fail) validateEnv > rejects placeholder domain"]),
    });

    const verdict = await deps.evaluate(feature("Invoice"), state());

    expect(verdict.passed).toBe(true);
  });

  test("differential gate FAILS when the feature introduces a NEW failure", async () => {
    const host = createHost();
    const exec: Exec = async () => ({
      code: 1,
      stdout:
        "(fail) validateEnv > rejects placeholder domain\n" +
        "(fail) invoice service > creates an invoice\n 2 fail\n",
      stderr: "",
    });

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec,
      evaluator: createEvaluator(),
      generate: async () => undefined,
      baseline: new Set(["(fail) validateEnv > rejects placeholder domain"]),
    });

    const verdict = await deps.evaluate(feature("Invoice"), state());

    expect(verdict.passed).toBe(false);
    expect(verdict.stage).toBe("gate");
    // The full novel-failure list is in `detail` (fed to the model's next attempt);
    // the baseline failure must NOT appear — the model can't touch it.
    expect(verdict.detail ?? "").toContain("invoice service");
    expect(verdict.detail ?? "").not.toContain("validateEnv");
  });
});
