import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/loop/boringstack/exec";
import {
  boringstackDeps,
  partitionBaseline,
  describeBaseline,
  rescueFileFor,
  runBoringstackBuild,
  scopeFor,
  readResourceCode,
  verifyAcceptance,
  e2eParkReason,
  loadBaseline,
  saveBaseline,
  APP_SCHEMA_FILE,
  LOCALE_GLOB,
  homeRouteForPlan,
  wireHomeRedirectForPlan,
} from "../src/loop/boringstack/build";
import type {
  IAcceptanceRunner,
  IAcceptanceOutcome,
  IEntityAcceptance,
} from "../src/loop/acceptance/acceptance.types";
import type { IProvider } from "../src/inference";
import type { IGate } from "../src/gate/gate-runner";
import { writePlan } from "../src/loop/planning/plan-store";
import { saveState } from "../src/loop/greenfield/state";
import type { IProductPlan, ISlice } from "../src/loop/planning/plan-types";

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
  const rescueTargets: string[] = [];
  const metaBaselineCaptures = { count: 0 };

  return {
    scopes,
    sent,
    gates,
    rescueTargets,
    metaBaselineCaptures,
    setScope: (g: string[]) => {
      scopes.push(g);
    },
    setGate: (g: unknown) => {
      gates.push(g);
    },
    setExpertRescueTarget: (f: string) => {
      rescueTargets.push(f);
    },
    captureMetaBaseline: () => {
      metaBaselineCaptures.count += 1;
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

/** A minimal single-slice approved plan, shared by the baseline-persistence tests. */
function invoicePlan(): IProductPlan {
  return {
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
          screens: ["list"],
          action: "create invoices",
          shows: ["amount"],
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
}

describe("homeRouteForPlan", () => {
  const mkSlice = (id: string, home: boolean): ISlice => ({
    entity: {
      id,
      desc: "d",
      fields: [{ name: "title", type: "string" }],
      relationships: ["belongsTo User"],
      rules: ["title required"],
    },
    ui: {
      screens: ["list", "form"],
      action: "a",
      shows: ["title"],
      nav: id,
      home,
    },
    verification: {
      mustRemainTrue: ["auth"],
      mustNotHappen: ["no title"],
      acceptanceCheck: "bun test",
    },
  });
  const plan = (slices: ISlice[]): IProductPlan => ({ product: "p", slices });

  test("returns the /camel route of the slice marked home", () => {
    expect(
      homeRouteForPlan(plan([mkSlice("Note", false), mkSlice("Task", true)]))
    ).toBe("/task");
  });

  test("returns null when no slice is home (login keeps the /dashboard default)", () => {
    expect(homeRouteForPlan(plan([mkSlice("Note", false)]))).toBeNull();
  });

  test("wireHomeRedirectForPlan APPLIES the redirect for a home plan, skips a home-less one", async () => {
    // Guards that the plan-level wiring actually FIRES (deleting the runBoringstackBuild call would
    // otherwise leave validate green while restoring the resume false-green). Injected applier.
    const calls: { cwd: string; route: string }[] = [];

    const apply = async (cwd: string, route: string): Promise<void> => {
      calls.push({ cwd, route });
    };

    await wireHomeRedirectForPlan(
      "/repo",
      plan([mkSlice("Note", false), mkSlice("Task", true)]),
      apply
    );
    expect(calls).toEqual([{ cwd: "/repo", route: "/task" }]);

    await wireHomeRedirectForPlan(
      "/repo",
      plan([mkSlice("Note", false)]),
      apply
    );
    // No home slice → no additional call.
    expect(calls).toEqual([{ cwd: "/repo", route: "/task" }]);
  });
});

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
    // The composed per-feature gate is injected into the session BEFORE the send —
    // this is the whole unification: the real gate now runs INSIDE the loop.
    expect(host.gates.length).toBe(1);
    expect(host.sent.length).toBe(1);
    expect(host.sent[0]).toContain("Invoice");
  });

  test("hands the OTHER features to the judge as siblings, derived from state", async () => {
    // Guards the state→gate wiring itself: the judge must receive the sibling ids that
    // come from state.features (minus the current one). A judgeStage-only test can't
    // catch this closure omitting siblings, including the current feature, or reading
    // the wrong state. Run the injected gate so the real judge prompt is observed.
    const base = createHost();
    let gate: IGate | undefined;
    const host = {
      ...base,
      setGate: (g: IGate) => {
        gate = g;
      },
    };
    const seen: string[] = [];
    const evaluator: IProvider = {
      complete: async (messages) => {
        for (const m of messages) {
          if (m.role === "user") {
            seen.push(m.content);
          }
        }

        return { content: '{"pass":true,"notes":"ok"}', toolCalls: [] };
      },
    };
    const st = {
      goal: "g",
      features: [feature("Supplier"), feature("Product")],
    };

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec: createExec(0),
      evaluator,
      generate: async () => {},
      generateUi: async () => {},
    });

    await deps.implement(feature("Supplier"), st);
    await gate?.run("/repo");

    const prompt = seen.join("\n");

    // The sibling (Product) reaches the judge; the clause is present.
    expect(prompt).toContain("Product");
    expect(prompt).toContain("separate slices");
  });

  test("a single-feature build passes NO sibling clause (current feature is excluded)", async () => {
    // Proves the current feature is not handed to itself as a sibling: with only
    // Supplier in state, siblings is empty, so the judge gets the unchanged prompt.
    const base = createHost();
    let gate: IGate | undefined;
    const host = {
      ...base,
      setGate: (g: IGate) => {
        gate = g;
      },
    };
    const seen: string[] = [];
    const evaluator: IProvider = {
      complete: async (messages) => {
        for (const m of messages) {
          if (m.role === "user") {
            seen.push(m.content);
          }
        }

        return { content: '{"pass":true,"notes":"ok"}', toolCalls: [] };
      },
    };
    const st = { goal: "g", features: [feature("Supplier")] };

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec: createExec(0),
      evaluator,
      generate: async () => {},
      generateUi: async () => {},
    });

    await deps.implement(feature("Supplier"), st);
    await gate?.run("/repo");

    expect(seen.join("\n")).not.toContain("separate slices");
  });

  test("delegates the DB sync to generate — no redundant, result-ignoring harness-level db:push", async () => {
    const host = createHost();
    const execCalls: { argv: string[]; cwd: string }[] = [];

    const exec: Exec = async (argv, opts) => {
      execCalls.push({ argv: [...argv], cwd: opts.cwd });

      return { code: 0, stdout: "", stderr: "" };
    };

    let generateCalled = false;

    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec,
      evaluator: createEvaluator(),
      generate: async () => {
        generateCalled = true;
      },
      generateUi: async () => undefined,
    });

    await deps.implement(feature("Invoice"), state());

    // The DB sync is `generate`'s responsibility: the real generateResource runs the
    // headless-safe dbPushForce (recover-or-throw) — proven in boringstack-generate +
    // db-push tests. The harness delegates to it…
    expect(generateCalled).toBe(true);
    // …and issues NO db:push of its own. A second harness-level push would be
    // redundant, and (since its result was ignored) could re-introduce the
    // swallowed-failure false-green the db:push fix removes.
    const harnessPushes = execCalls.filter(
      (c) => c.argv.join(" ") === "bun run db:push -- --force"
    );

    expect(harnessPushes).toHaveLength(0);
  });

  test("a revisit tells the model which escalation approaches were already exhausted", async () => {
    const host = createHost();
    const deps = boringstackDeps({
      host,
      cwd: "/repo",
      exec: createExec(),
      evaluator: createEvaluator(),
      generate: async () => undefined,
      generateUi: async () => undefined,
    });

    await deps.implement(feature("Invoice"), state(), {
      triedLevers: ["R1", "R2", "R3"],
    });

    expect(host.sent[0]).toContain("REVISIT");
    expect(host.sent[0]).toContain("R1, R2, R3");
    expect(host.sent[0]).toContain("materially different route");
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

describe("describeBaseline", () => {
  test("a passing baseline is GREEN", () => {
    const r = describeBaseline(true, 0);

    expect(r.kind).toBe("tool");
    expect(r.message).toContain("GREEN");
  });

  test("a RED baseline with parsed failures is surfaced as RED (excluded from grading)", () => {
    const r = describeBaseline(false, 3);

    expect(r.kind).toBe("stuck");
    expect(r.message).toContain("RED");
    expect(r.message).toContain("3");
  });

  test("a RED baseline with ZERO parsed signatures is NEVER reported GREEN (the silent-green bug)", () => {
    const r = describeBaseline(false, 0);

    expect(r.kind).toBe("stuck");
    expect(r.message).not.toContain("GREEN");
    expect(r.message).toContain("did NOT parse");
  });
});

describe("partitionBaseline", () => {
  test("keeps ordinary pre-existing failures as the baseline, no infra", () => {
    const { infra, baseline } = partitionBaseline([
      "failure:apps%2Fapi%2Fsrc%2Ffoo.ts:1:TS2322:bad",
      "knip:unused-file:src/orphan.ts",
    ]);

    expect(baseline.size).toBe(2);
    expect(infra).toEqual([]);
  });

  test("splits openapi-unreachable OUT into infra (never the baseline) so the differential gate can't suppress the infra signal → false green", () => {
    const { infra, baseline } = partitionBaseline([
      "failure:apps%2Fapi%2Fsrc%2Ffoo.ts:1:TS2322:bad",
      "openapi-unreachable:connection-refused",
    ]);

    expect(baseline.size).toBe(1);
    expect(
      [...baseline].some((s) => s.startsWith("openapi-unreachable:"))
    ).toBe(false);
    expect(infra).toEqual(["openapi-unreachable:connection-refused"]);
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

  test("includes shared sidebar and router files (add-only, not edit existing entries)", () => {
    const scope = scopeFor("Company");

    // The sidebar and router are shared UI files. A feature is unreachable (fails
    // browser acceptance tests) if the model doesn't register a NavLink for the feature
    // in the sidebar and a route entry in the router. Add-only: the model may ADD its
    // feature's entry, never modify another feature's entry or remove entries.
    expect(scope).toContain(
      "apps/ui/src/components/core/AppSidebar/AppSidebar.tsx"
    );
    expect(scope).toContain("apps/ui/src/app/router/routes.tsx");
  });

  test("includes the sidebar's co-located test so the model can bump its nav-link count", () => {
    // Adding a NavLink (required for reachability) changes the count AppSidebar.test.tsx asserts;
    // if the model can't edit that test, the FINAL full-project validate fails even though the
    // feature is verified. The test file must be in scope.
    expect(scopeFor("Company")).toContain(
      "apps/ui/src/components/core/AppSidebar/AppSidebar.test.tsx"
    );
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

  test("throws a clear error when an entity id is not a PascalCase identifier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bs-"));

    try {
      const plan: IProductPlan = {
        product: "A simple app",
        slices: [
          {
            entity: {
              id: "Purchase Order", // space → not an identifier-safe id
              desc: "x",
              fields: [],
              relationships: [],
              rules: [],
            },
            ui: { screens: ["list"], action: "x", shows: [], nav: "x" },
            verification: {
              mustRemainTrue: [],
              mustNotHappen: ["x"],
              acceptanceCheck: "x",
            },
          },
        ],
      };

      await writePlan(dir, plan, "approved");

      // Fail fast with an actionable message BEFORE any generation, rather than
      // breaking opaquely downstream on the malformed <camel>Routes/path/i18n id.
      const host = createHost();
      let generateCalls = 0;
      let generateUiCalls = 0;

      await expect(
        runBoringstackBuild({
          cwd: dir,
          goal: "x",
          host,
          evaluator: createEvaluator(),
          exec: createExec(),
          generate: async () => {
            generateCalls += 1;
          },
          generateUi: async () => {
            generateUiCalls += 1;
          },
        })
      ).rejects.toThrow(/invalid entity id.*Purchase Order.*PascalCase/su);

      // The guarantee is fail-fast BEFORE any side effect: no code generated, no
      // baseline captured, no model turn dispatched. A regression that moved the
      // check after generation/baseline would still throw but break these.
      expect(generateCalls).toBe(0);
      expect(generateUiCalls).toBe(0);
      expect(host.metaBaselineCaptures.count).toBe(0);
      expect(host.sent).toEqual([]);
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
      // The pristine meta-baseline was captured exactly once, before feature work.
      expect(host.metaBaselineCaptures.count).toBe(1);
      // The per-feature expert rescue target was set (Invoice's service file).
      expect(host.rescueTargets.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails CLOSED (needs-infra) when the pristine gate can't reach the API's OpenAPI spec", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bs-"));

    try {
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
              screens: ["list"],
              action: "create invoices",
              shows: ["amount"],
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
      // The pristine baseline gate is RED solely because generate:api can't reach
      // the API — an infra precondition, not a code defect the model can fix.
      const exec: Exec = async () => ({
        code: 1,
        stdout:
          "::tsforge-app apps/ui::\n" +
          "[generate:api] FAILED: fetch failed (ECONNREFUSED)",
        stderr: "",
      });

      const res = await runBoringstackBuild({
        cwd: dir,
        goal: "simple app",
        host,
        evaluator: createEvaluator(),
        exec,
        generate: async () => undefined,
        generateUi: async () => undefined,
      });

      expect(res.status).toBe("needs-infra");
      expect(res.infra).toContain("OpenAPI spec");
      // It stopped BEFORE any feature work: no meta-baseline, nothing sent to the model.
      expect(host.metaBaselineCaptures.count).toBe(0);
      expect(host.sent.length).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("gate parity: applies the deterministic auto-fixes right before final acceptance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bs-"));

    // Disable e2e acceptance for this test (we're testing gate parity, not acceptance)
    const originalEnv = process.env.TSFORGE_NO_E2E_ACCEPTANCE;

    try {
      process.env.TSFORGE_NO_E2E_ACCEPTANCE = "1";

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
              screens: ["list"],
              action: "create invoices",
              shows: ["amount"],
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

      const execCalls: { argv: string[]; cwd: string }[] = [];

      const exec: Exec = async (argv, opts) => {
        execCalls.push({ argv: [...argv], cwd: opts.cwd });

        return { code: 0, stdout: "", stderr: "" };
      };

      const res = await runBoringstackBuild({
        cwd: dir,
        goal: "simple app",
        host: createHost(),
        evaluator: createEvaluator(),
        exec,
        generate: async () => undefined,
        generateUi: async () => undefined,
      });

      expect(res.status).toBe("done");

      // The FULL acceptance gate ran…
      const full = execCalls.findIndex(
        (c) =>
          c.argv[0] === "bash" && c.argv.join(" ").includes("bun run validate")
      );

      expect(full).toBeGreaterThan(0);

      // …and the SIX exec calls immediately before it are the full autofixApps
      // contract — clear eslint cache + lint:fix + format for BOTH apps — proving
      // acceptance is preceded by the same deterministic auto-fixes the per-cycle gate
      // applies. The `rm -f .eslintcache` FIRST is the type-aware-lint soundness fix:
      // eslint --cache can return a stale-clean result for a file whose content is
      // unchanged but whose cross-file types changed, so the cache is cleared each cycle.
      // ORDER: `lint:fix` (eslint --fix) BEFORE `format` (prettier --write) — prettier LAST so the
      // gate's `format:check` always converges (else eslint --fix re-formats after prettier and
      // format:check fails on it with nothing left to fix it — build44 Contact opaqueGateError).
      // Dropping the cache clear, `format`, the ordering, or the api half must fail this.
      const before = execCalls
        .slice(full - 6, full)
        .map((c) => `${c.argv.join(" ")} @ ${c.cwd.replace(dir, "")}`);

      expect(before).toEqual([
        "rm -f .eslintcache @ /apps/api",
        "bun run lint:fix @ /apps/api",
        "bun run format @ /apps/api",
        "rm -f .eslintcache @ /apps/ui",
        "bun run lint:fix @ /apps/ui",
        "bun run format @ /apps/ui",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });

      // Restore env var
      if (originalEnv === undefined) {
        delete process.env.TSFORGE_NO_E2E_ACCEPTANCE;
      } else {
        process.env.TSFORGE_NO_E2E_ACCEPTANCE = originalEnv;
      }
    }
  });
});

describe("readResourceCode — feeds the completeness judge", () => {
  test("includes .tsx COMPONENTS (not just .ts) and excludes test/story files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-rrc-"));

    try {
      const uiComp = join(
        dir,
        "apps/ui/src/features/company/components/CompanyPage"
      );

      await mkdir(uiComp, { recursive: true });
      await mkdir(join(dir, "apps/api/src/api/company"), { recursive: true });

      await writeFile(
        join(dir, "apps/api/src/api/company/company.service.ts"),
        "export const companyService = 1;\n"
      );
      // The React component the judge must see — a .tsx, previously dropped by the .ts-only filter.
      await writeFile(
        join(uiComp, "CompanyPage.tsx"),
        "export const CompanyPage = () => <main>COMPONENT_MARKER</main>;\n"
      );
      await writeFile(
        join(uiComp, "CompanyPage.hooks.ts"),
        "export const useCompanyPage = () => HOOK_MARKER;\n"
      );
      // A test + story that must NOT eat the judge's budget.
      await writeFile(
        join(uiComp, "CompanyPage.test.tsx"),
        "// TEST_MARKER should be excluded\n"
      );
      await writeFile(
        join(uiComp, "CompanyPage.stories.tsx"),
        "// STORY_MARKER should be excluded\n"
      );

      const code = await readResourceCode(dir, "Company");

      // The .tsx component is now included (the core fix).
      expect(code).toContain("COMPONENT_MARKER");
      expect(code).toContain("CompanyPage.tsx");
      // .ts logic still included; API still included.
      expect(code).toContain("HOOK_MARKER");
      expect(code).toContain("companyService");
      // Test + story files are excluded (they don't help completeness judging + waste budget).
      expect(code).not.toContain("TEST_MARKER");
      expect(code).not.toContain("STORY_MARKER");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("excludes API test files too (same budget hygiene as the UI side)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-rrc-apitest-"));

    try {
      const apiDir = join(dir, "apps/api/src/api/company");

      await mkdir(apiDir, { recursive: true });

      await writeFile(
        join(apiDir, "company.service.ts"),
        "export const svc = 'API_SVC_MARKER';\n"
      );
      // API co-located test — must NOT reach the judge (wastes budget), same as UI.
      await writeFile(
        join(apiDir, "company.service.test.ts"),
        "// API_TEST_MARKER should be excluded\n"
      );

      const code = await readResourceCode(dir, "Company");

      expect(code).toContain("API_SVC_MARKER");
      expect(code).not.toContain("API_TEST_MARKER");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("excludes singular .story files and __tests__ directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-rrc-exclforms-"));

    try {
      const uiDir = join(dir, "apps/ui/src/features/company");

      await mkdir(join(uiDir, "components"), { recursive: true });
      await mkdir(join(uiDir, "__tests__"), { recursive: true });

      await writeFile(
        join(uiDir, "components", "CompanyPage.tsx"),
        "export const CompanyPage = () => <main>REAL_COMPONENT</main>;\n"
      );
      // Singular `.story.tsx` (not just `.stories.tsx`) must be excluded.
      await writeFile(
        join(uiDir, "components", "CompanyPage.story.tsx"),
        "// SINGULAR_STORY_MARKER should be excluded\n"
      );
      // Anything under a __tests__ directory must be excluded.
      await writeFile(
        join(uiDir, "__tests__", "helpers.tsx"),
        "// TESTS_DIR_MARKER should be excluded\n"
      );

      const code = await readResourceCode(dir, "Company");

      expect(code).toContain("REAL_COMPONENT");
      expect(code).not.toContain("SINGULAR_STORY_MARKER");
      expect(code).not.toContain("TESTS_DIR_MARKER");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readResourceCode — budget + ordering (root-cause coverage)", () => {
  test("a marker only reachable after ~85k of content survives (proves the cap is ~96k, not a small regression)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-rrc-budget-"));

    try {
      const apiDir = join(dir, "apps/api/src/api/company");
      const uiComp = join(
        dir,
        "apps/ui/src/features/company/components/CompanyPage"
      );

      await mkdir(apiDir, { recursive: true });
      await mkdir(uiComp, { recursive: true });

      // Five ~17k COMPONENTS (.tsx). Under global component-first ordering these are read
      // BEFORE any API file, and each fits individually, so all five are accepted and push
      // cumulative length to ~86k — a comfortable ~10k under the 96k cap. Block size derives
      // ONLY from the fixed relPath + fixed pad (NOT the tmpdir prefix, which never appears in
      // the emitted blocks), so the total is constant across runs — no boundary flakiness.
      const bulk = (n: number): string =>
        `export const Comp${n} = () => <main>bulk ${n}</main>;\n${`// pad ${n}\n`.repeat(1900)}`;

      for (let n = 1; n <= 5; n += 1) {
        await writeFile(join(uiComp, `Comp${n}.tsx`), bulk(n));
      }

      // The marker lives in a plain API .ts (rank-1) → read AFTER all five components, i.e.
      // only reachable once cumulative length has passed ~85k. Present ⟺ the cap genuinely
      // exceeds ~85k. A regression to a small cap (e.g. 30000) truncates before the marker.
      await writeFile(
        join(apiDir, "company.service.ts"),
        `export const svc = 'BUDGET_MARKER_DEEP';\n`
      );

      const code = await readResourceCode(dir, "Company");

      expect(code).toContain("BUDGET_MARKER_DEEP");
      expect(code.length).toBeGreaterThan(70000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("truncates content beyond the ~96k cap (proves the cap is bounded, not removed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-rrc-trunc-"));

    try {
      const uiComp = join(dir, "apps/ui/src/features/company/components");

      await mkdir(uiComp, { recursive: true });

      // Four ~30k components (sorted by path Comp1..Comp4) → ~120k total, exceeding the cap.
      // The reader must stop before Comp4, so its marker is DROPPED. This is the upper-bound
      // guard the ~85k lower-bound test can't give: if the cap were raised substantially or
      // removed, Comp4 would be included and this fails.
      const bulk = (n: number, marker: string): string =>
        `export const Comp${n} = () => <main>${marker}</main>;\n${`// pad ${n}\n`.repeat(3300)}`;

      await writeFile(join(uiComp, "Comp1.tsx"), bulk(1, "FIRST_MARKER"));
      await writeFile(join(uiComp, "Comp2.tsx"), bulk(2, "bulk2"));
      await writeFile(join(uiComp, "Comp3.tsx"), bulk(3, "bulk3"));
      await writeFile(join(uiComp, "Comp4.tsx"), bulk(4, "TRUNCATED_MARKER"));

      const code = await readResourceCode(dir, "Company");

      // Early content included, late content dropped, total bounded below the cap.
      expect(code).toContain("FIRST_MARKER");
      expect(code).toContain("[truncated]");
      expect(code).not.toContain("TRUNCATED_MARKER");
      expect(code.length).toBeLessThan(96000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("orders a UI component BEFORE an API service (global component-first, cross-app)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-rrc-global-"));

    try {
      const apiDir = join(dir, "apps/api/src/api/company");
      const uiComp = join(
        dir,
        "apps/ui/src/features/company/components/CompanyPage"
      );

      await mkdir(apiDir, { recursive: true });
      await mkdir(uiComp, { recursive: true });

      // API service is discovered first (API dir is read before the UI dir), but the .tsx
      // component must still be emitted ahead of it — proving the ordering is GLOBAL, not
      // merely within the UI file list.
      await writeFile(
        join(apiDir, "company.service.ts"),
        "export const svc = 'API_SVC_MARKER';\n"
      );
      await writeFile(
        join(uiComp, "CompanyPage.tsx"),
        "export const CompanyPage = () => <main>UI_COMPONENT_MARKER</main>;\n"
      );

      const code = await readResourceCode(dir, "Company");

      expect(code).toContain("UI_COMPONENT_MARKER");
      expect(code).toContain("API_SVC_MARKER");
      expect(code.indexOf("UI_COMPONENT_MARKER")).toBeLessThan(
        code.indexOf("API_SVC_MARKER")
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sorts SAME-RANK files by path, independent of discovery/creation order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-rrc-samerank-"));

    try {
      const apiDir = join(dir, "apps/api/src/api/company");

      await mkdir(apiDir, { recursive: true });

      // Three same-rank (.ts, non-component) files CREATED in reverse-path order. An
      // implementation that kept discovery/insertion order (readdir order tracks creation
      // order on some filesystems) would emit z→m→a; the path tiebreak must emit a→m→z.
      await writeFile(
        join(apiDir, "zebra.service.ts"),
        "export const z = 'Z';\n"
      );
      await writeFile(
        join(apiDir, "mango.service.ts"),
        "export const m = 'M';\n"
      );
      await writeFile(
        join(apiDir, "alpha.service.ts"),
        "export const a = 'A';\n"
      );

      const code = await readResourceCode(dir, "Company");

      expect(code.indexOf("alpha.service.ts")).toBeLessThan(
        code.indexOf("mango.service.ts")
      );
      expect(code.indexOf("mango.service.ts")).toBeLessThan(
        code.indexOf("zebra.service.ts")
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("includes .jsx components and orders components before non-component .ts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-rrc-jsx-"));

    try {
      const uiDir = join(dir, "apps/ui/src/features/company");

      await mkdir(join(uiDir, "components"), { recursive: true });

      await writeFile(
        join(uiDir, "components", "CompanyPage.jsx"),
        "export const CompanyPage = () => 'JSX_COMPONENT_MARKER';\n"
      );
      await writeFile(
        join(uiDir, "Company.queries.ts"),
        "export const useCompany = () => 'TS_LOGIC_MARKER';\n"
      );

      const code = await readResourceCode(dir, "Company");

      expect(code).toContain("JSX_COMPONENT_MARKER");
      expect(code).toContain("TS_LOGIC_MARKER");
      // Component (.jsx) is emitted before the plain .ts logic (component-first ordering).
      expect(code.indexOf("JSX_COMPONENT_MARKER")).toBeLessThan(
        code.indexOf("TS_LOGIC_MARKER")
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyAcceptance — truthful park reason on done:false", () => {
  function acceptanceEntity(): IEntityAcceptance {
    return {
      id: "Company",
      key: "name",
      nav: "Companies",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Acme",
          invalid: [""],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a company and see it in the list",
    };
  }

  function stubRunner(outcomes: IAcceptanceOutcome[]): IAcceptanceRunner {
    let i = 0;

    return {
      run: async () => {
        const idx = Math.min(i, outcomes.length - 1);

        i += 1;

        const out = outcomes[idx];

        if (out === undefined) {
          throw new Error("stubRunner: no outcome configured");
        }

        return out;
      },
      runChain: async () => ({ ok: true, results: [] }),
    };
  }

  test("fast-gate failure (no e2e) reports the fast-gate reason, not e2e", async () => {
    const result = await verifyAcceptance(
      { status: "stuck" },
      createHost(),
      "/tmp/does-not-exist",
      undefined,
      undefined,
      true,
      undefined
    );

    expect(result.done).toBe(false);
    expect(result.reason).toContain("fast gate not green");
  });

  test("acceptance enabled but runner missing reports a misconfiguration reason", async () => {
    const result = await verifyAcceptance(
      { status: "done" },
      createHost(),
      "/tmp/does-not-exist",
      acceptanceEntity(),
      undefined,
      false,
      undefined
    );

    expect(result.done).toBe(false);
    expect(result.reason).toContain("misconfiguration");
  });

  test("fast-gate-green-but-e2e-failed reports the e2e reason with detail (NOT 'ladder exhausted')", async () => {
    // The build52 case: the fast gate passed, but the browser acceptance still fails after
    // the steer. The reason must say so — the old code parked this as "ladder exhausted".
    const failing: IAcceptanceOutcome = {
      ok: false,
      results: [
        { entity: "Company", step: "list", ok: false, detail: "row not found" },
      ],
      detail: "the created company did not appear in the list",
    };
    // host.send returns done → the steer completed; the re-run still fails.
    const result = await verifyAcceptance(
      { status: "done" },
      createHost(),
      "/tmp/does-not-exist",
      acceptanceEntity(),
      stubRunner([failing, failing]),
      false,
      undefined
    );

    expect(result.done).toBe(false);
    expect(result.reason).toContain("e2e acceptance");
    expect(result.reason).toContain(
      "the created company did not appear in the list"
    );
    expect(result.reason).not.toContain("ladder exhausted");
  });

  test("e2e failed AND the fix steer did not complete reports the steer-incomplete reason", async () => {
    // The other done:false e2e branch: the browser assertions failed and the steer itself
    // stalled (host.send returns a non-"done" status). The reason must name the steer stall.
    const failing: IAcceptanceOutcome = {
      ok: false,
      results: [
        { entity: "Company", step: "create", ok: false, detail: "no submit" },
      ],
      detail: "the create form never submitted",
    };
    const stuckHost = {
      ...createHost(),
      send: async () => ({ status: "stuck", turns: 1 }),
    };
    const result = await verifyAcceptance(
      { status: "done" },
      stuckHost,
      "/tmp/does-not-exist",
      acceptanceEntity(),
      stubRunner([failing, failing]),
      false,
      undefined
    );

    expect(result.done).toBe(false);
    expect(result.reason).toContain("the fix steer did not complete");
    expect(result.reason).toContain("the create form never submitted");
  });

  test("steer incomplete but re-run PASSED parks WITHOUT blaming e2e assertions", async () => {
    // The subtle case: browser acceptance failed, the steer ran, the re-run PASSED, but the
    // steer itself did not complete cleanly → done:false. The reason must NOT report a stale
    // "assertions failing" (the app verified); it must name the steer stall.
    const failing: IAcceptanceOutcome = {
      ok: false,
      results: [
        { entity: "Company", step: "list", ok: false, detail: "empty" },
      ],
      detail: "list was empty before the fix",
    };
    const passing: IAcceptanceOutcome = { ok: true, results: [] };
    const stuckHost = {
      ...createHost(),
      send: async () => ({ status: "stuck", turns: 1 }),
    };
    const result = await verifyAcceptance(
      { status: "done" },
      stuckHost,
      "/tmp/does-not-exist",
      acceptanceEntity(),
      stubRunner([failing, passing]),
      false,
      undefined
    );

    expect(result.done).toBe(false);
    expect(result.reason).toContain("passed on re-run");
    expect(result.reason).toContain("the fix steer did not complete");
    // Must NOT surface the obsolete pre-steer failure detail.
    expect(result.reason).not.toContain("list was empty before the fix");
    expect(result.reason).not.toContain("still failing");
  });

  test("all checks passing reports done with no reason", async () => {
    const passing: IAcceptanceOutcome = { ok: true, results: [] };
    const result = await verifyAcceptance(
      { status: "done" },
      createHost(),
      "/tmp/does-not-exist",
      acceptanceEntity(),
      stubRunner([passing]),
      false,
      undefined
    );

    expect(result.done).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe("e2eParkReason — the pure reason composer", () => {
  const fail = (detail?: string): IAcceptanceOutcome => ({
    ok: false,
    results: [],
    ...(detail !== undefined ? { detail } : {}),
  });
  const pass: IAcceptanceOutcome = { ok: true, results: [] };

  test("re-run still failing after a completed steer → 'after the fix steer'", () => {
    const reason = e2eParkReason(true, fail("orig"), fail("still red"));

    expect(reason).toContain("still failing after the fix steer");
    expect(reason).toContain("still red");
  });

  test("re-run still failing AND steer incomplete → names both", () => {
    const reason = e2eParkReason(false, fail("orig"), fail("still red"));

    expect(reason).toContain(
      "still failing AND the fix steer did not complete"
    );
    expect(reason).toContain("still red");
  });

  test("re-run PASSED but steer incomplete → steer-stall reason, NO stale detail", () => {
    const reason = e2eParkReason(false, fail("orig failure"), pass);

    expect(reason).toContain("passed on re-run");
    expect(reason).toContain("the fix steer did not complete");
    expect(reason).not.toContain("orig failure");
  });

  test("skips a failing step whose detail is BLANK for a later failing step that has one", () => {
    // Distinguishing: the FIRST failing step has an empty detail; the real diagnostic is on a
    // LATER failing step. `find(r => !r.ok)` (the old predicate) would pick the blank one and
    // fall through to the pre-steer detail; the non-empty filter picks the real later one.
    const reRun: IAcceptanceOutcome = {
      ok: false,
      results: [
        { entity: "Company", step: "list", ok: false, detail: "" },
        {
          entity: "Company",
          step: "create",
          ok: false,
          detail: "LATER_STEP_DETAIL",
        },
      ],
    };
    const reason = e2eParkReason(true, fail("pre-steer detail"), reRun);

    expect(reason).toContain("LATER_STEP_DETAIL");
    expect(reason).not.toContain("pre-steer detail");
  });

  test("treats a BLANK top-level re-run detail as absent and uses a failing-step detail", () => {
    // `"" ?? x` keeps "", so a blank top-level detail must be normalized to absent, else it
    // suppresses the real step diagnostic and emits an empty reason.
    const reRun: IAcceptanceOutcome = {
      ok: false,
      detail: "",
      results: [
        { entity: "Company", step: "create", ok: false, detail: "STEP_REAL" },
      ],
    };
    const reason = e2eParkReason(true, fail("pre-steer"), reRun);

    expect(reason).toContain("STEP_REAL");
  });

  test("falls back to the pre-steer outcome's failing-STEP detail, not only its top-level", () => {
    // The re-run surfaced no usable detail at all; the pre-steer outcome's detail lives only
    // on a failing step, so `outcome.detail` alone would drop it in favor of the generic text.
    const reRun: IAcceptanceOutcome = { ok: false, results: [] };
    const outcome: IAcceptanceOutcome = {
      ok: false,
      results: [
        {
          entity: "Company",
          step: "create",
          ok: false,
          detail: "PRE_STEP_DETAIL",
        },
      ],
    };
    const reason = e2eParkReason(true, outcome, reRun);

    expect(reason).toContain("PRE_STEP_DETAIL");
    expect(reason).not.toContain("browser acceptance assertions failed");
  });
});

describe("baseline persistence — resume-safe differential grading", () => {
  test("saveBaseline → loadBaseline round-trips passed + the signature set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-"));

    try {
      const sigs = new Set([
        "failure:a.ts:1:no-unused-vars:msg",
        "failure:b.ts:2:react-hooks%2Fexhaustive-deps:msg2",
      ]);

      await saveBaseline(dir, { passed: false, signatures: sigs });
      const loaded = await loadBaseline(dir);

      expect(loaded).not.toBeNull();
      expect(loaded?.passed).toBe(false);
      expect([...(loaded?.signatures ?? [])].sort()).toEqual([...sigs].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadBaseline returns null when none is persisted (→ a FRESH build captures)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-none-"));

    try {
      expect(await loadBaseline(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a GREEN pristine baseline persists as passed:true + empty set, NOT null (so a resume REUSES it)", async () => {
    // The load-bearing case: build55's pristine scaffold was GREEN → empty baseline. It must
    // round-trip as PRESENT (passed:true, empty set), so a resume reuses it and does NOT
    // re-capture from the contaminated tree. If it round-tripped as null, the resume would
    // re-capture → the false-green this fix prevents.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-green-"));

    try {
      await saveBaseline(dir, { passed: true, signatures: new Set<string>() });
      const loaded = await loadBaseline(dir);

      expect(loaded).not.toBeNull();
      expect(loaded?.passed).toBe(true);
      expect(loaded?.signatures.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a RED-but-unparseable baseline persists passed:FALSE + empty set — never re-inferred GREEN from size", async () => {
    // The critical bug the panel caught: a RED pristine gate whose output did NOT parse into
    // known signatures is ALSO `signatures: []`. The passed bit MUST be stored separately, or a
    // resume with `size === 0` would announce it GREEN — the exact false-green this file fixes.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-redunparsed-"));

    try {
      await saveBaseline(dir, { passed: false, signatures: new Set<string>() });
      const loaded = await loadBaseline(dir);

      expect(loaded).not.toBeNull();
      expect(loaded?.passed).toBe(false);
      expect(loaded?.signatures.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadBaseline returns null on a wrong-shape file (e.g. the OLD bare-array format)", async () => {
    // A bare array (no passed bit) must be rejected → re-capture, not silently treated as a
    // valid passed:false/true baseline. Guards against loading a pre-format-change file.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-shape-"));

    try {
      await mkdir(join(dir, ".tsforge/greenfield"), { recursive: true });
      await writeFile(
        join(dir, ".tsforge/greenfield/baseline.json"),
        JSON.stringify(["failure:a.ts:1:rule:msg"])
      );

      expect(await loadBaseline(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadBaseline returns null on corrupt JSON (re-capture, never crash)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-corrupt-"));

    try {
      await mkdir(join(dir, ".tsforge/greenfield"), { recursive: true });
      await writeFile(
        join(dir, ".tsforge/greenfield/baseline.json"),
        "{not valid json"
      );

      expect(await loadBaseline(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runBoringstackBuild persists on a FRESH build and REUSES on resume (not re-captured from the contaminated tree)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-e2e-"));

    try {
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
              screens: ["list"],
              action: "create invoices",
              shows: ["amount"],
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

      // FRESH build: the baseline gate passes (createExec(0)) → a passed:true baseline is
      // captured and PERSISTED.
      await runBoringstackBuild({
        cwd: dir,
        goal: "app",
        host: createHost(),
        evaluator: createEvaluator(),
        exec: createExec(0),
        generate: async () => undefined,
        generateUi: async () => undefined,
      });

      const afterFresh = await loadBaseline(dir);

      expect(afterFresh).not.toBeNull();
      expect(afterFresh?.passed).toBe(true);

      // RESUME (greenfield state now exists): even though the gate now FAILS (createExec(1)),
      // the persisted GREEN baseline is REUSED — NOT re-captured from the non-pristine tree —
      // so it stays passed:true. A re-capture would have overwritten it to passed:false.
      await runBoringstackBuild({
        cwd: dir,
        goal: "app",
        host: createHost(),
        evaluator: createEvaluator(),
        exec: createExec(1),
        generate: async () => undefined,
        generateUi: async () => undefined,
      });

      const afterResume = await loadBaseline(dir);

      expect(afterResume?.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runBoringstackBuild grades STRICT on a resume whose baseline.json was lost — no crash, no contaminated re-capture persisted", async () => {
    // The safety-critical fallback branch: a greenfield checklist EXISTS (it's a resume) but
    // the persisted baseline is gone (older build / deleted file). The tree is non-pristine, so
    // this invocation's gate capture is CONTAMINATED. The build must fall back to STRICT grading
    // (empty baseline, nothing excluded — only ever over-strict, never a false-green) and must
    // NOT persist that contaminated capture as a new baseline. Assert: it runs without crashing
    // and loadBaseline stays null (the contaminated capture was never frozen in).
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-strict-"));

    try {
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
              screens: ["list"],
              action: "create invoices",
              shows: ["amount"],
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

      // First run establishes the greenfield checklist (making the next run a RESUME) and a
      // persisted baseline.
      await runBoringstackBuild({
        cwd: dir,
        goal: "app",
        host: createHost(),
        evaluator: createEvaluator(),
        exec: createExec(0),
        generate: async () => undefined,
        generateUi: async () => undefined,
      });

      expect(await loadBaseline(dir)).not.toBeNull();

      // Simulate a LOST baseline.json — the checklist survives, the baseline doesn't.
      await rm(join(dir, ".tsforge", "greenfield", "baseline.json"), {
        force: true,
      });
      expect(await loadBaseline(dir)).toBeNull();

      // RESUME with a now-FAILING (contaminated) gate. The strict fallback must engage.
      const res = await runBoringstackBuild({
        cwd: dir,
        goal: "app",
        host: createHost(),
        evaluator: createEvaluator(),
        exec: createExec(1),
        generate: async () => undefined,
        generateUi: async () => undefined,
      });

      // It did not crash…
      expect(res.status).toBeDefined();
      // …and the contaminated capture was NOT persisted as a baseline (strict fallback, not
      // a re-capture that would later EXCLUDE this feature's own failures from grading).
      expect(await loadBaseline(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a FRESH build captures the meta-rule baseline exactly once AND persists the command baseline", async () => {
    // Positive control for the two resume-safety fixes: on the pristine tree we DO capture
    // the meta baseline and DO persist the command baseline. The resume tests below assert
    // the negatives (neither happens on a resume).
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-fresh-"));

    try {
      await writePlan(dir, invoicePlan(), "approved");
      const host = createHost();

      await runBoringstackBuild({
        cwd: dir,
        goal: "app",
        host,
        evaluator: createEvaluator(),
        exec: createExec(0),
        generate: async () => undefined,
        generateUi: async () => undefined,
      });

      expect(host.metaBaselineCaptures.count).toBe(1);
      expect(await loadBaseline(dir)).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a resume does NOT re-capture the meta baseline and emits NO false pristine-baseline report — only the strict warning", async () => {
    // The critical scope-bypass fix: on a resume the tree is contaminated, so re-capturing
    // the meta baseline would sweep pre-interruption meta violations (workflow/lockfile/
    // root-drift) into the baseline and EXCLUDE them — the same false-green, for the meta
    // gate. On a resume the meta baseline must NOT be captured (→ STRICT), and the strict
    // fallback must NOT emit the "RED … did NOT parse" pristine-baseline report (which would
    // contradict its own warning).
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-resume-meta-"));

    try {
      await writePlan(dir, invoicePlan(), "approved");
      // A checklist exists (→ RESUME) but no baseline.json (→ strict fallback).
      await saveState(dir, { goal: "app", features: [] });
      expect(await loadBaseline(dir)).toBeNull();

      const host = createHost();
      const events: string[] = [];

      await runBoringstackBuild({
        cwd: dir,
        goal: "app",
        host,
        evaluator: createEvaluator(),
        exec: createExec(1),
        generate: async () => undefined,
        generateUi: async () => undefined,
        onEvent: (e) => {
          events.push(e.message);
        },
      });

      // Meta baseline NOT captured on a resume (strict), so the "nothing excluded" warning is true.
      expect(host.metaBaselineCaptures.count).toBe(0);
      // The strict-fallback warning IS emitted…
      expect(events.some((m) => m.includes("falls back to STRICT"))).toBe(true);
      // …and the false "RED … did NOT parse" pristine-baseline report is NOT (it describes a
      // pristine capture that does not exist on this path).
      expect(events.some((m) => m.includes("did NOT parse"))).toBe(false);
      // The contaminated tree was never frozen in as a baseline.
      expect(await loadBaseline(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a CORRUPT features.json is treated as a RESUME (strict), never a fresh start — no contaminated capture persisted", async () => {
    // The gate-relaxed fix: `loadState` returns null for a corrupt file just as for a missing
    // one, so detecting a fresh start via loadState would treat a corrupt-state resume (whose
    // tree WAS already built into) as pristine and persist a CONTAMINATED baseline. Presence
    // (`hasState`) is the correct signal: a corrupt checklist still means "resume → strict".
    const dir = await mkdtemp(join(tmpdir(), "tsforge-baseline-corrupt-"));

    try {
      await writePlan(dir, invoicePlan(), "approved");
      // A present-but-unparseable checklist — loadState() would see null (looks fresh),
      // hasState() sees the file (correctly: resume).
      await mkdir(join(dir, ".tsforge", "greenfield"), { recursive: true });
      await writeFile(
        join(dir, ".tsforge", "greenfield", "features.json"),
        "{ this is not valid json"
      );

      const host = createHost();

      await runBoringstackBuild({
        cwd: dir,
        goal: "app",
        host,
        evaluator: createEvaluator(),
        exec: createExec(1),
        generate: async () => undefined,
        generateUi: async () => undefined,
      });

      // Treated as a resume: strict fallback, so NO fresh baseline was persisted from the
      // contaminated tree, and the meta baseline was NOT captured.
      expect(await loadBaseline(dir)).toBeNull();
      expect(host.metaBaselineCaptures.count).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
