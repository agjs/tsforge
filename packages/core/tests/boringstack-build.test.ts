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
  APP_SCHEMA_FILE,
  LOCALE_GLOB,
} from "../src/loop/boringstack/build";
import type { IProvider } from "../src/inference";
import type { IGate } from "../src/gate/gate-runner";
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
});

describe("readResourceCode — budget + ordering (root-cause coverage)", () => {
  test("a >16k component survives (proves the budget raise, not the old 16000 cap)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-rrc-budget-"));

    try {
      const apiDir = join(dir, "apps/api/src/api/company");
      const uiComp = join(
        dir,
        "apps/ui/src/features/company/components/CompanyPage"
      );

      await mkdir(apiDir, { recursive: true });
      await mkdir(uiComp, { recursive: true });

      // ~18k of API .ts (would alone blow the OLD 16000 budget before UI is even read).
      const filler = "// filler line to consume budget\n".repeat(560);

      await writeFile(
        join(apiDir, "company.service.ts"),
        `export const svc = 1;\n${filler}`
      );
      // The component carries a UNIQUE marker near its end — only visible if the budget
      // is large enough to include the UI after ~18k of API text.
      await writeFile(
        join(uiComp, "CompanyPage.tsx"),
        "export const CompanyPage = () => <main>BUDGET_MARKER_TSX</main>;\n"
      );

      const code = await readResourceCode(dir, "Company");

      // Under the old 16000 cap this would have truncated before the UI → marker absent.
      expect(code).toContain("BUDGET_MARKER_TSX");
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
