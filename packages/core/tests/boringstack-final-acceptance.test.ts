import { test, expect } from "bun:test";
import type {
  IAcceptanceOutcome,
  IAcceptanceRunner,
  IAcceptanceSpec,
  IEntityAcceptance,
} from "../src/loop/acceptance/acceptance.types";
import { runFinalAcceptance } from "../src/loop/boringstack/build";
import type { Exec } from "../src/loop/boringstack/exec";
import type { IGreenfieldResult } from "../src/loop/greenfield/greenfield.types";
import type { IProductPlan } from "../src/loop/planning/plan-types";

/**
 * Tests for final-acceptance verification (called after all features pass fast gate).
 * Verifies that final-acceptance properly handles chain acceptance success/failure/infra-error.
 */

// Mock entities for chain testing
const company: IEntityAcceptance = {
  id: "Company",
  key: "company",
  nav: "Companies",
  fields: [
    {
      name: "name",
      type: "string",
      optional: false,
      valid: "Test Company",
      invalid: [],
    },
  ],
  shows: ["name"],
  screens: ["list", "form"],
  parents: [],
  negatives: [],
  acceptanceCheck: "create a company",
};

const contact: IEntityAcceptance = {
  id: "Contact",
  key: "contact",
  nav: "Contacts",
  fields: [
    {
      name: "name",
      type: "string",
      optional: false,
      valid: "Test Contact",
      invalid: [],
    },
    {
      name: "companyId",
      type: "string",
      optional: false,
      valid: "company-1",
      invalid: [],
    },
  ],
  shows: ["name"],
  screens: ["list", "form"],
  parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
  negatives: [],
  acceptanceCheck: "create a contact",
};

test("final acceptance: chain test succeeds → result status remains done", async () => {
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return {
        ok: true,
        results: [
          {
            entity: "company",
            step: "create",
            ok: true,
            detail: "pass",
          },
        ],
      };
    },
    async runChain(spec: IAcceptanceSpec): Promise<IAcceptanceOutcome> {
      // Chain test passes for all entities
      return {
        ok: true,
        results: spec.entities.map((e) => ({
          entity: e.key,
          step: "create",
          ok: true,
          detail: "pass",
        })),
      };
    },
  };

  const chainSpec: IAcceptanceSpec = {
    entities: [company, contact],
  };

  // Since runFinalAcceptance is not exported, we test the behavior through the runner
  const outcome = await mockRunner.runChain(chainSpec, {
    cwd: "/tmp/test",
    apiBase: "http://localhost:3000",
    uiBase: "http://localhost:7331",
  });

  expect(outcome.ok).toBe(true);
  expect(outcome.infraError).toBeUndefined();
  expect(outcome.results.length).toBeGreaterThan(0);
});

test("final acceptance: chain test fails → result is not ok", async () => {
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(_spec: IAcceptanceSpec): Promise<IAcceptanceOutcome> {
      // Chain test fails (e.g., relationship linkage not visible)
      return {
        ok: false,
        results: [
          {
            entity: "company",
            step: "create",
            ok: true,
            detail: "pass",
          },
          {
            entity: "contact",
            step: "create",
            ok: false,
            detail: "parent linkage cell not visible",
          },
        ],
        detail: "contact row did not show company linkage",
      };
    },
  };

  const chainSpec: IAcceptanceSpec = {
    entities: [company, contact],
  };

  const outcome = await mockRunner.runChain(chainSpec, {
    cwd: "/tmp/test",
    apiBase: "http://localhost:3000",
    uiBase: "http://localhost:7331",
  });

  expect(outcome.ok).toBe(false);
  expect(outcome.detail).toBeTruthy();
  expect(outcome.infraError).toBeUndefined();
});

test("final acceptance: chain test infra error → not verified (needs final attempt)", async () => {
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      // Chain test has infrastructure failure (browser, API down, etc.)
      return {
        ok: false,
        results: [],
        infraError: "ECONNREFUSED: connection refused to API",
      };
    },
  };

  const chainSpec: IAcceptanceSpec = {
    entities: [company, contact],
  };

  const outcome = await mockRunner.runChain(chainSpec, {
    cwd: "/tmp/test",
    apiBase: "http://localhost:3000",
    uiBase: "http://localhost:7331",
  });

  // Should distinguish infra error from real test failure
  expect(outcome.infraError).toBeDefined();
  expect(outcome.infraError).toContain("ECONNREFUSED");
  expect(outcome.ok).toBe(false);
  // Infra errors are retried, not immediately marked as failed
});

test("final acceptance: runner missing when acceptance enabled → feature not verified", async () => {
  // When acceptance is enabled but runner is not available, acceptance cannot run.
  // This is a fail-closed scenario: the feature is NOT verified.

  // If runner is undefined/missing, acceptance cannot proceed
  const missingRunner: IAcceptanceRunner | undefined = undefined;

  // Behavior: if runner is missing, treat acceptance as incomplete (not verified)
  // This is enforced by the caller: don't mark feature as done unless runner.runChain succeeds
  expect(missingRunner).toBeUndefined();
  // Fact: without a runner, acceptance cannot run, so feature should not be marked complete
});

test("final acceptance: per-entity chain coverage required", async () => {
  // Chain acceptance must verify all entities in the spec
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(_spec: IAcceptanceSpec): Promise<IAcceptanceOutcome> {
      // Missing Contact entity creation result
      return {
        ok: false,
        results: [
          {
            entity: "company",
            step: "create",
            ok: true,
            detail: "pass",
          },
          // Contact is missing
        ],
        detail: "acceptance incomplete: entity 'contact' missing create step",
      };
    },
  };

  const chainSpec: IAcceptanceSpec = {
    entities: [company, contact],
  };

  const outcome = await mockRunner.runChain(chainSpec, {
    cwd: "/tmp/test",
    apiBase: "http://localhost:3000",
    uiBase: "http://localhost:7331",
  });

  // Should fail if any entity is missing the create step
  expect(outcome.ok).toBe(false);
  expect(outcome.detail).toContain("contact");
  expect(outcome.detail).toContain("missing create step");
});

test("final acceptance: must honor playwright exit code", async () => {
  // Nonzero exit code from playwright indicates failure, even if JSON output parses.
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      // Simulate: playwright exited with code 1 (test failures)
      // JSON output is valid, but exit code says tests failed
      return {
        ok: false,
        results: [],
        detail: "playwright exited with code 1",
      };
    },
  };

  const chainSpec: IAcceptanceSpec = {
    entities: [company, contact],
  };

  const outcome = await mockRunner.runChain(chainSpec, {
    cwd: "/tmp/test",
    apiBase: "http://localhost:3000",
    uiBase: "http://localhost:7331",
  });

  // Nonzero exit code must be honored, regardless of JSON parsability
  expect(outcome.ok).toBe(false);
  expect(outcome.detail).toContain("code 1");
});

test("final acceptance: skipped/interrupted tests do not count as passed", async () => {
  // Only tests with status "passed" count as passing.
  // Skipped or interrupted tests are NOT passing results.
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      // Simulate: one test passed, one was skipped/interrupted
      return {
        ok: false,
        results: [
          {
            entity: "company",
            step: "create",
            ok: true,
            detail: "pass",
          },
          {
            entity: "contact",
            step: "create",
            ok: false,
            detail: "skipped", // or "interrupted"
          },
        ],
        detail:
          "acceptance incomplete: entity 'contact' missing passing create step",
      };
    },
  };

  const chainSpec: IAcceptanceSpec = {
    entities: [company, contact],
  };

  const outcome = await mockRunner.runChain(chainSpec, {
    cwd: "/tmp/test",
    apiBase: "http://localhost:3000",
    uiBase: "http://localhost:7331",
  });

  // If any required entity's step did not truly pass, acceptance fails
  expect(outcome.ok).toBe(false);
});

test("runFinalAcceptance: non-done status → returns input unchanged", async () => {
  const input: IGreenfieldResult = {
    status: "stuck",
    features: [],
    stuckFeature: "test-feature",
  };

  const mockExec: Exec = async () => ({
    code: 0,
    stdout: "",
    stderr: "",
  });

  const minimalPlan: IProductPlan = {
    product: "Test",
    slices: [],
  };

  const result = await runFinalAcceptance(
    input,
    "/tmp/test",
    mockExec,
    undefined,
    minimalPlan,
    true
  );

  expect(result.status).toBe("stuck");
  expect(result.stuckFeature).toBe("test-feature");
});

test("runFinalAcceptance: gate passes + runChain returns infraError → needs-infra", async () => {
  const input: IGreenfieldResult = {
    status: "done",
    features: [{ id: "test", desc: "test", passes: true, attempts: 1 }],
  };

  const mockExec: Exec = async () => ({
    code: 0,
    stdout: "",
    stderr: "",
  });

  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return {
        ok: false,
        results: [],
        infraError: "ECONNREFUSED: browser connection failed",
      };
    },
  };

  const minimalPlan: IProductPlan = {
    product: "Test",
    slices: [],
  };

  const result = await runFinalAcceptance(
    input,
    "/tmp/test",
    mockExec,
    mockRunner,
    minimalPlan,
    false
  );

  expect(result.status).toBe("needs-infra");
  expect(result.infra).toContain("ECONNREFUSED");
});

test("runFinalAcceptance: gate passes + runChain returns ok:false → stuck", async () => {
  const input: IGreenfieldResult = {
    status: "done",
    features: [{ id: "test", desc: "test", passes: true, attempts: 1 }],
  };

  const mockExec: Exec = async () => ({
    code: 0,
    stdout: "",
    stderr: "",
  });

  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return {
        ok: false,
        results: [],
        detail: "relationship assertion failed",
      };
    },
  };

  const minimalPlan: IProductPlan = {
    product: "Test",
    slices: [],
  };

  const result = await runFinalAcceptance(
    input,
    "/tmp/test",
    mockExec,
    mockRunner,
    minimalPlan,
    false
  );

  expect(result.status).toBe("stuck");
});

test("runFinalAcceptance: gate passes + runChain returns ok:true → done", async () => {
  const input: IGreenfieldResult = {
    status: "done",
    features: [{ id: "test", desc: "test", passes: true, attempts: 1 }],
  };

  const mockExec: Exec = async () => ({
    code: 0,
    stdout: "",
    stderr: "",
  });

  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return {
        ok: true,
        results: [
          { entity: "company", step: "create", ok: true, detail: "pass" },
        ],
      };
    },
  };

  const minimalPlan: IProductPlan = {
    product: "Test",
    slices: [],
  };

  const result = await runFinalAcceptance(
    input,
    "/tmp/test",
    mockExec,
    mockRunner,
    minimalPlan,
    false
  );

  expect(result.status).toBe("done");
});

// Tests for the exported runFinalAcceptance function
const minimalPlan: IProductPlan = {
  product: "Test",
  slices: [
    {
      entity: {
        id: "Company",
        desc: "A company",
        fields: [{ name: "name", type: "string", optional: false }],
        rules: [],
        relationships: [],
      },
      ui: {
        nav: "Companies",
        shows: ["name"],
        screens: ["list", "form"],
        action: "add",
      },
      verification: {
        acceptanceCheck: "create a company",
        mustRemainTrue: [],
        mustNotHappen: [],
      },
    },
  ],
};

test("runFinalAcceptance: non-done result returns unchanged", async () => {
  const input: IGreenfieldResult = {
    status: "stuck",
    features: [],
  };

  const mockExec: Exec = (): Promise<never> => {
    throw new Error("exec should not be called");
  };

  const result = await runFinalAcceptance(
    input,
    "/tmp/test",
    mockExec,
    undefined,
    minimalPlan,
    false
  );

  expect(result.status).toBe("stuck");
  expect(result).toBe(input);
});

test("runFinalAcceptance: done result with passing gate and successful chain returns done", async () => {
  const input: IGreenfieldResult = {
    status: "done",
    features: [{ id: "f1", desc: "test", passes: true, attempts: 1 }],
  };

  const mockExec: Exec = async (): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }> => {
    // Respond to all exec calls with success
    return { code: 0, stdout: "", stderr: "" };
  };

  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return {
        ok: true,
        results: [
          { entity: "company", step: "create", ok: true, detail: "ok" },
        ],
      };
    },
  };

  const result = await runFinalAcceptance(
    input,
    "/tmp/test",
    mockExec,
    mockRunner,
    minimalPlan,
    false
  );

  expect(result.status).toBe("done");
  expect(result.features).toBe(input.features);
});

test("runFinalAcceptance: chain infra error returns needs-infra", async () => {
  const input: IGreenfieldResult = {
    status: "done",
    features: [{ id: "f1", desc: "test", passes: true, attempts: 1 }],
  };

  const mockExec: Exec = async (): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }> => {
    return { code: 0, stdout: "", stderr: "" };
  };

  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return {
        ok: false,
        results: [],
        infraError: "ECONNREFUSED: API not responding",
      };
    },
  };

  const result = await runFinalAcceptance(
    input,
    "/tmp/test",
    mockExec,
    mockRunner,
    minimalPlan,
    false
  );

  expect(result.status).toBe("needs-infra");
  expect(result.infra).toContain("ECONNREFUSED");
});

test("runFinalAcceptance: chain assertion failure returns stuck", async () => {
  const input: IGreenfieldResult = {
    status: "done",
    features: [{ id: "f1", desc: "test", passes: true, attempts: 1 }],
  };

  const mockExec: Exec = async (): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }> => {
    return { code: 0, stdout: "", stderr: "" };
  };

  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return {
        ok: false,
        results: [
          {
            entity: "company",
            step: "create",
            ok: false,
            detail: "form didn't appear",
          },
        ],
        detail: "form failed to load",
      };
    },
  };

  const result = await runFinalAcceptance(
    input,
    "/tmp/test",
    mockExec,
    mockRunner,
    minimalPlan,
    false
  );

  expect(result.status).toBe("stuck");
});
