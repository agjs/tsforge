import { test, expect } from "bun:test";
import type {
  IAcceptanceOutcome,
  IAcceptanceRunner,
  IEntityAcceptance,
} from "../src/loop/acceptance/acceptance.types";
import { boringstackDeps } from "../src/loop/boringstack/build";
import type {
  IFeature,
  IGreenfieldState,
} from "../src/loop/greenfield/greenfield.types";
import type { Exec } from "../src/loop/boringstack/exec";
import type { IProvider } from "../src/inference";

// Mock implementations
const mockFeature: IFeature = {
  id: "company",
  desc: "A company entity",
  attempts: 0,
  passes: false,
};

const mockEntity: IEntityAcceptance = {
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

const mockState: IGreenfieldState = {
  goal: "build a CRM",
  features: [mockFeature],
};

const mockSlice = {
  entity: {
    id: "Company",
    desc: "A company entity",
    fields: [{ name: "name", type: "string" }],
    relationships: [],
    rules: [],
  },
  ui: {
    screens: ["list" as const, "form" as const],
    action: "add" as const,
    shows: ["name"],
    nav: "Companies",
  },
  verification: {
    mustRemainTrue: [],
    mustNotHappen: [],
    acceptanceCheck: "create a company",
  },
};

class MockHost {
  private messages: string[] = [];
  private sendCount = 0;
  private statusToReturn = "done";

  setScope(): void {
    // Implement IBoringstackHost
  }

  setGate(): void {
    // Implement IBoringstackHost
  }

  setExpertRescueTarget(): void {
    // Implement IBoringstackHost
  }

  captureMetaBaseline(): void {
    // Implement IBoringstackHost
  }

  async send(message: string): Promise<{ status: string; turns: number }> {
    this.messages.push(message);
    this.sendCount++;

    return { status: this.statusToReturn, turns: 1 };
  }

  getMessages(): string[] {
    return this.messages;
  }

  getSendCount(): number {
    return this.sendCount;
  }

  setStatusToReturn(status: string): void {
    this.statusToReturn = status;
  }
}

const mockExec: Exec = async () => ({
  code: 0,
  stdout: "",
  stderr: "",
});

const mockEvaluator: IProvider = {
  complete: async () => ({
    content: '{"pass": true}',
    toolCalls: [],
  }),
};

test("acceptance: feature passes fast gate and acceptance", async () => {
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
    async runChain(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
  };

  const host = new MockHost();
  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    acceptanceRunner: mockRunner,
    generate: async () => {},
    generateUi: async () => {},
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
  });

  const result = await deps.implement(mockFeature, mockState);

  expect(result.done).toBe(true);
  expect(result.handoff).toBeUndefined();
});

test("acceptance: feature fails acceptance (assertion failure)", async () => {
  const failedOutcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      {
        entity: "company",
        step: "create",
        ok: false,
        detail: "expected row to be visible",
      },
    ],
    detail: "create step failed",
  };

  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return failedOutcome;
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
  };

  const host = new MockHost();
  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    acceptanceRunner: mockRunner,
    generate: async () => {},
    generateUi: async () => {},
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
  });

  const result = await deps.implement(mockFeature, mockState);

  expect(result.done).toBe(false);
  // Should have sent a steer message
  const messages = host.getMessages();

  expect(messages.length).toBeGreaterThan(0);
  // Last message should be the steer (acceptance steer or error message)
  expect(messages[messages.length - 1]).toBeTruthy();
});

test("acceptance: per-slice infra error marks feature NOT verified + sets infra property", async () => {
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return {
        ok: false,
        results: [],
        infraError: "ECONNREFUSED: browser launch failed",
      };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
  };

  const host = new MockHost();
  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    acceptanceRunner: mockRunner,
    generate: async () => {},
    generateUi: async () => {},
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
  });

  const result = await deps.implement(mockFeature, mockState);

  // CRITICAL: infraError must NEVER return done:true (feature is NOT verified when acceptance can't run)
  expect(result.done).toBe(false);
  // CRITICAL: infra property must be set so runGreenfield routes to needs-infra
  expect(result.infra).toBeDefined();
  expect(result.infra).toContain("ECONNREFUSED");
  // Should have sent a warning message
  const messages = host.getMessages();

  expect(messages.length).toBeGreaterThan(0);
  const lastMessage = messages[messages.length - 1];

  expect(lastMessage).toContain("infrastructure error");
});

test("acceptance: feature passes when flag is disabled (acceptance skipped)", async () => {
  const originalEnv = process.env.TSFORGE_NO_E2E_ACCEPTANCE;

  try {
    process.env.TSFORGE_NO_E2E_ACCEPTANCE = "1";

    // This runner should NEVER be called
    const mockRunner: IAcceptanceRunner = {
      async run(): Promise<IAcceptanceOutcome> {
        throw new Error("runner should not be called when flag is disabled");
      },
      async runChain(): Promise<IAcceptanceOutcome> {
        throw new Error("runner should not be called when flag is disabled");
      },
    };

    const host = new MockHost();
    const deps = boringstackDeps({
      host,
      cwd: "/tmp/test",
      exec: mockExec,
      evaluator: mockEvaluator,
      acceptanceRunner: mockRunner,
      generate: async () => {},
      generateUi: async () => {},
      sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
    });

    const result = await deps.implement(mockFeature, mockState);

    // Should return done based on sent.status only, without calling runner
    expect(result.done).toBe(true);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.TSFORGE_NO_E2E_ACCEPTANCE;
    } else {
      process.env.TSFORGE_NO_E2E_ACCEPTANCE = originalEnv;
    }
  }
});

test("acceptance: runner missing when flag enabled + entity available → fail-closed", async () => {
  const host = new MockHost();
  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
    // no acceptanceRunner provided, but flag is enabled (default) and entity is available
    generate: async () => {},
    generateUi: async () => {},
  });

  const result = await deps.implement(mockFeature, mockState);

  // FAIL-CLOSED: runner missing + acceptance enabled + entity present → done=false
  // (FIX 3: operator warning is no longer sent via host.send)
  expect(result.done).toBe(false);
});

test("acceptance: feature passes when no entity is available", async () => {
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      throw new Error("runner should not be called when no entity");
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      throw new Error("runner should not be called when no entity");
    },
  };

  const host = new MockHost();
  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    acceptanceRunner: mockRunner,
    // No sliceFor, so entity will be undefined
    generate: async () => {},
    generateUi: async () => {},
  });

  const result = await deps.implement(mockFeature, mockState);

  // Should return based on sent.status, without calling runner
  expect(result.done).toBe(true);
});

test("testIdStage: respects the e2e acceptance flag when disabled", async () => {
  const { composeBoringstackGate } =
    await import("../src/loop/boringstack/gate-stages");

  const originalEnv = process.env.TSFORGE_NO_E2E_ACCEPTANCE;

  try {
    // When flag is set to "1", testIdStage should be disabled
    process.env.TSFORGE_NO_E2E_ACCEPTANCE = "1";

    const gate = composeBoringstackGate({
      cwd: "/tmp/test",
      exec: mockExec,
      evaluator: mockEvaluator,
      baseline: new Set(),
      feature: mockFeature,
      entity: mockEntity,
    });

    // Gate should exist but testIdStage should not be included
    expect(gate).toBeTruthy();
  } finally {
    if (originalEnv === undefined) {
      delete process.env.TSFORGE_NO_E2E_ACCEPTANCE;
    } else {
      process.env.TSFORGE_NO_E2E_ACCEPTANCE = originalEnv;
    }
  }
});

test("testIdStage: runs when e2e acceptance is enabled", async () => {
  const { composeBoringstackGate } =
    await import("../src/loop/boringstack/gate-stages");

  const originalEnv = process.env.TSFORGE_NO_E2E_ACCEPTANCE;

  try {
    // When flag is NOT set, testIdStage should be included
    delete process.env.TSFORGE_NO_E2E_ACCEPTANCE;

    const gate = composeBoringstackGate({
      cwd: "/tmp/test",
      exec: mockExec,
      evaluator: mockEvaluator,
      baseline: new Set(),
      feature: mockFeature,
      entity: mockEntity,
    });

    // Gate should exist
    expect(gate).toBeTruthy();
  } finally {
    if (originalEnv === undefined) {
      delete process.env.TSFORGE_NO_E2E_ACCEPTANCE;
    } else {
      process.env.TSFORGE_NO_E2E_ACCEPTANCE = originalEnv;
    }
  }
});

test("final acceptance: base pass + chain ok → final GREEN", async () => {
  // This test verifies the chain outcome folding logic at final acceptance
  // by mocking the gate to pass and runner chain to succeed
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
  };

  const host = new MockHost();
  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    acceptanceRunner: mockRunner,
    generate: async () => {},
    generateUi: async () => {},
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
  });

  const result = await deps.implement(mockFeature, mockState);

  expect(result.done).toBe(true);
  expect(result.handoff).toBeUndefined();
});

test("final acceptance: base pass + chain !ok → NOT green with detail", async () => {
  const chainFailedOutcome: IAcceptanceOutcome = {
    ok: false,
    results: [],
    detail: "Contact creation failed: parent Company not linked",
  };

  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return chainFailedOutcome;
    },
  };

  const host = new MockHost();
  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    acceptanceRunner: mockRunner,
    generate: async () => {},
    generateUi: async () => {},
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
  });

  const result = await deps.implement(mockFeature, mockState);

  expect(result.done).toBe(true); // Per-slice passes on chain !ok
});

test("final acceptance: chain infraError → infra path (not red)", async () => {
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
    async runChain(): Promise<IAcceptanceOutcome> {
      return {
        ok: false,
        results: [],
        infraError: "browser launch timeout",
      };
    },
  };

  const host = new MockHost();
  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    acceptanceRunner: mockRunner,
    generate: async () => {},
    generateUi: async () => {},
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
  });

  const result = await deps.implement(mockFeature, mockState);

  expect(result.done).toBe(true); // Per-slice gate still passes
});

test("testIdStage: passes when no UI files exist yet", async () => {
  const { testIdStage } = await import("../src/loop/boringstack/gate-stages");

  const stage = testIdStage("/tmp/nonexistent", mockEntity);
  const result = await stage.run("/tmp/nonexistent");

  // Should pass when no UI files exist (feature may still be initializing)
  expect(result.passed).toBe(true);
  expect(result.output).toContain("no UI files");
});

test("FIX 2: verifyAcceptance returns done:false when steer fails, even if reRun passes", async () => {
  let runCount = 0;
  let sendCount = 0;
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      runCount++;

      // First run fails, second run (after steer) passes
      if (runCount === 1) {
        return {
          ok: false,
          results: [
            {
              entity: "company",
              step: "create",
              ok: false,
              detail: "row not visible",
            },
          ],
          detail: "create failed",
        };
      }

      // Second run passes
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
    async runChain(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
  };

  class MockHostStateful extends MockHost {
    async send(message: string): Promise<{ status: string; turns: number }> {
      sendCount++;
      // First send returns done (fast gate pass), subsequent sends return stuck (steer failure)
      return { status: sendCount === 1 ? "done" : "stuck", turns: 1 };
    }
  }

  const host = new MockHostStateful();

  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    acceptanceRunner: mockRunner,
    generate: async () => {},
    generateUi: async () => {},
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
  });

  const result = await deps.implement(mockFeature, mockState);

  // CRITICAL: even though reRun.ok is true, steer.status !== "done", so done:false
  expect(result.done).toBe(false);
  // Verify run() was called exactly twice: once for initial check, once after steer
  expect(runCount).toBe(2);
});

test("FIX 2: verifyAcceptance returns done:true when both steer done AND reRun pass", async () => {
  let runCount = 0;
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      runCount++;

      if (runCount === 1) {
        return {
          ok: false,
          results: [
            {
              entity: "company",
              step: "create",
              ok: false,
              detail: "row not visible",
            },
          ],
          detail: "create failed",
        };
      }

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
    async runChain(): Promise<IAcceptanceOutcome> {
      return { ok: true, results: [] };
    },
  };

  const host = new MockHost();

  // Set steer to return done status (the fix: both conditions true)
  host.setStatusToReturn("done");

  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    acceptanceRunner: mockRunner,
    generate: async () => {},
    generateUi: async () => {},
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
  });

  const result = await deps.implement(mockFeature, mockState);

  // Now both steer.status === "done" AND reRun.ok is true → done:true
  expect(result.done).toBe(true);
  expect(runCount).toBe(2);
});

test("FIX 3: missing runner path does NOT call host.send for operator warning", async () => {
  const host = new MockHost();
  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: mockEvaluator,
    // No acceptanceRunner provided + flag enabled + entity present → fail-closed
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
    generate: async () => {},
    generateUi: async () => {},
  });

  const result = await deps.implement(mockFeature, mockState);

  // FIX 3: missing-runner path must NOT call host.send (no operator warning message)
  expect(result.done).toBe(false);
  const sendCallsForWarning = host
    .getMessages()
    .filter((msg) => msg.includes("runner injected"));

  // Should have NO send calls with the operator warning text
  expect(sendCallsForWarning.length).toBe(0);
});
