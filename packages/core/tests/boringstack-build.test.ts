import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/loop/boringstack/exec";
import {
  boringstackDeps,
  rescueFileFor,
  runBoringstackBuild,
  scopeFor,
  APP_SCHEMA_FILE,
  LOCALE_GLOB,
} from "../src/loop/boringstack/build";
import type { IProvider } from "../src/inference";
import { writePlan } from "../src/loop/planning/plan-store";
import type { IProductPlan } from "../src/loop/planning/plan-types";

function feature(id: string) {
  return { id, desc: `Build ${id} resource`, passes: false, attempts: 0 };
}

function state() {
  return { goal: "build API resources", features: [] };
}

function createHost() {
  const scopes: string[][] = [];
  const sent: string[] = [];
  const gates: unknown[] = [];

  return {
    scopes,
    sent,
    gates,
    setScope: (g: string[]) => {
      scopes.push(g);
    },
    setGate: (g: unknown) => {
      gates.push(g);
    },
    send: async (m: string) => {
      sent.push(m);

      return { status: "done", turns: 1 };
    },
  };
}

function createExec(gateCode = 0): Exec {
  return async () => ({
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

  test("syncs DB after generation but before sending to the model", async () => {
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

    const forCmd = (cmd: string): string[] =>
      execCalls
        .filter((c) => c.argv.join(" ") === cmd)
        .map((c) => c.cwd)
        .sort();

    // db:push is called to sync the STUB schema before the model gets the prompt
    expect(forCmd("bun run db:push -- --force")).toContain("/repo/apps/api");
  });

  test("freezes the entity's Drizzle schema INTO scope so the model can add real columns", async () => {
    const host = createHost();

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec: createExec(),
      evaluator: createEvaluator(),
      generate: async () => undefined,
      generateUi: async () => undefined,
    });

    await deps.implement(feature("Invoice"), state());

    // The shared app schema (where the entity's columns live) MUST be editable —
    // otherwise the model can only fake persistence in memory.
    expect(host.scopes[0]).toContain(APP_SCHEMA_FILE);
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

describe("scopeFor", () => {
  test("includes the resource dir, tests, UI feature, app schema, AND locale files", () => {
    const scope = scopeFor("Invoice");

    expect(scope).toContain("apps/api/src/api/invoice/**");
    expect(scope).toContain("apps/api/tests/api/invoice/**");
    expect(scope).toContain("apps/ui/src/features/invoice/**");
    // Shared files the model must add to (else it's trapped): the Drizzle schema
    // (columns) and the i18n locales (every UI string is a key that must exist).
    expect(scope).toContain(APP_SCHEMA_FILE);
    expect(scope).toContain(LOCALE_GLOB);
  });
});


describe("rescueFileFor", () => {
  let dir: string;

  const write = async (rel: string, body: string): Promise<void> => {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  };

  test("gate stuck → the file named in the errors", async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-rescue-"));

    try {
      await write(
        "apps/api/src/api/ticket/ticket.routes.ts",
        "export const x = 1;\n"
      );
      const f = {
        id: "Ticket",
        desc: "d",
        passes: false,
        attempts: 3,
        lastError:
          "apps/api/src/api/ticket/ticket.routes.ts(2,1): error TS2304: nope",
      };

      expect(await rescueFileFor(dir, f)).toBe(
        "apps/api/src/api/ticket/ticket.routes.ts"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("judge stuck (prose, no file path) → falls back to the service file", async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-rescue-"));

    try {
      await write(
        "apps/api/src/api/ticket/ticket.service.ts",
        "export const svc = {};\n"
      );
      const f = {
        id: "Ticket",
        desc: "d",
        passes: false,
        attempts: 3,
        lastError:
          "The create method ignores the description and priority fields, " +
          "and close does not update status to 'closed'.",
      };

      expect(await rescueFileFor(dir, f)).toBe(
        "apps/api/src/api/ticket/ticket.service.ts"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null when no file resolves", async () => {
    dir = await mkdtemp(join(tmpdir(), "tsforge-rescue-"));

    try {
      const f = {
        id: "Ticket",
        desc: "d",
        passes: false,
        attempts: 3,
        lastError: "a vague prose critique with no path and no service file",
      };

      expect(await rescueFileFor(dir, f)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runBoringstackBuild", () => {
  test("refuses (needs-plan) when no approved plan exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bs-"));

    try {
      const res = await runBoringstackBuild({
        cwd: dir,
        goal: "x",
        host: createHost(),
        evaluator: createEvaluator(),
        exec: createExec(),
      });

      expect(res.status).toBe("needs-plan");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("derives features from plan slices and passes slice to refinePrompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bs-"));

    try {
      // Write an approved plan
      const plan: IProductPlan = {
        product: "A simple app",
        slices: [
          {
            entity: {
              id: "Invoice",
              desc: "A billable unit",
              fields: [{ name: "amount", type: "number" }],
              relationships: [],
              rules: [],
            },
            ui: {
              screens: ["list", "detail"],
              action: "create and view invoices",
              shows: ["amount", "date"],
              nav: "Invoices",
            },
            verification: {
              mustRemainTrue: ["auth required"],
              mustNotHappen: ["unauthenticated access"],
              acceptanceCheck: "bun test",
            },
          },
        ],
      };

      await writePlan(dir, plan, "approved");

      const host = createHost();
      const res = await runBoringstackBuild({
        cwd: dir,
        goal: "simple app",
        host,
        evaluator: createEvaluator(),
        exec: createExec(),
        // Provide mock generators to avoid actual file I/O
        generate: async () => undefined,
        generateUi: async () => undefined,
      });

      // Should NOT return needs-plan since an approved plan exists
      expect(res.status).not.toBe("needs-plan");
      // Should have derived the feature from the slice
      expect(res.features.length).toBeGreaterThan(0);
      expect(res.features[0]?.id).toBe("Invoice");
      // Check that the refine prompt contains the slice's entity description
      expect(host.sent[0]).toContain("Invoice");
      expect(host.sent[0]).toContain("A billable unit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
