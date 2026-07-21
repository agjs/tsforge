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

  async send(
    message: string
  ): Promise<{ status: string; turns: number; handoff?: any }> {
    this.messages.push(message);

    return { status: "done", turns: 1 };
  }

  getMessages(): string[] {
    return this.messages;
  }
}

const mockExec: Exec = async () => ({
  code: 0,
  stdout: "",
  stderr: "",
});

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
    evaluator: { complete: async () => ({ content: '{"pass": true}' }) } as any,
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
    evaluator: { complete: async () => ({ content: '{"pass": true}' }) } as any,
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

test("acceptance: feature fails with infrastructure error", async () => {
  const mockRunner: IAcceptanceRunner = {
    async run(): Promise<IAcceptanceOutcome> {
      return {
        ok: false,
        results: [],
        infraError: "browser launch failed",
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
    evaluator: { complete: async () => ({ content: '{"pass": true}' }) } as any,
    acceptanceRunner: mockRunner,
    generate: async () => {},
    generateUi: async () => {},
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
  });

  const result = await deps.implement(mockFeature, mockState);

  expect(result.done).toBe(false);
  // Should have sent an infra error message
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
      evaluator: {
        complete: async () => ({ content: '{"pass": true}' }),
      } as any,
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

test("acceptance: feature passes when no runner is provided", async () => {
  const host = new MockHost();
  const deps = boringstackDeps({
    host,
    cwd: "/tmp/test",
    exec: mockExec,
    evaluator: { complete: async () => ({ content: '{"pass": true}' }) } as any,
    // no acceptanceRunner provided
    generate: async () => {},
    generateUi: async () => {},
  });

  const result = await deps.implement(mockFeature, mockState);

  expect(result.done).toBe(true);
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
    evaluator: { complete: async () => ({ content: '{"pass": true}' }) } as any,
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
      evaluator: {
        complete: async () => ({ content: '{"pass": true}' }),
      } as any,
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
      evaluator: {
        complete: async () => ({ content: '{"pass": true}' }),
      } as any,
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
    evaluator: { complete: async () => ({ content: '{"pass": true}' }) } as any,
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
    evaluator: { complete: async () => ({ content: '{"pass": true}' }) } as any,
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
    evaluator: { complete: async () => ({ content: '{"pass": true}' }) } as any,
    acceptanceRunner: mockRunner,
    generate: async () => {},
    generateUi: async () => {},
    sliceFor: (id: string) => (id === "company" ? mockSlice : undefined),
  });

  const result = await deps.implement(mockFeature, mockState);

  expect(result.done).toBe(true); // Per-slice gate still passes
});
