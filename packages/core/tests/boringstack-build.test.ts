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

    const generate = async (cwd: string, name: string) => {
      generateCalls.push({ cwd, name });
    };

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec,
      evaluator,
      generate,
    });

    await deps.implement(feature("Invoice"), state());

    expect(generateCalls.length).toBe(1);
    expect(generateCalls[0]?.name).toBe("Invoice");
    expect(generateCalls[0]?.cwd).toBe("/repo");
    expect(host.scopes.length).toBe(1);
    expect(host.scopes[0]).toContain("apps/api/src/api/invoice/**");
    expect(host.sent.length).toBe(1);
    expect(host.sent[0]).toContain("Invoice");
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
});
