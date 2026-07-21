import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Exec } from "../src/loop/boringstack/exec";
import { makeBoringstackAcceptanceRunner } from "../src/loop/boringstack/acceptance/e2e-runner";
import type {
  IEntityAcceptance,
  IAcceptanceRunCtx,
} from "../src/loop/acceptance/acceptance.types";

/**
 * Create a test context with a temporary directory.
 */
function createTestCtx(
  overrides?: Partial<IAcceptanceRunCtx>
): IAcceptanceRunCtx {
  const tmpDir = join(
    tmpdir(),
    `e2e-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  mkdirSync(tmpDir, { recursive: true });

  return {
    cwd: tmpDir,
    apiBase: "http://localhost:3000",
    uiBase: "http://localhost:7331",
    ...overrides,
  };
}

/**
 * Test entity: Company
 */
const testEntity: IEntityAcceptance = {
  id: "Company",
  key: "company",
  nav: "Companies",
  fields: [
    {
      name: "name",
      type: "string",
      optional: false,
      valid: "TestCo",
      invalid: [],
    },
    {
      name: "website",
      type: "string",
      optional: true,
      valid: "https://example.com",
      invalid: [],
    },
  ],
  shows: ["name", "website"],
  screens: ["list", "form"],
  parents: [],
  negatives: [
    {
      field: "name",
      value: "",
      why: "name is required",
    },
  ],
  acceptanceCheck: "create a company",
};

test("runner: fake Exec returning nested Playwright JSON report parses correctly", async () => {
  const report = {
    suites: [
      {
        title: "e2e/company.spec.ts",
        suites: [],
        specs: [
          {
            title: "navigate to company list via sidebar",
            ok: true,
            tests: [
              {
                results: [
                  {
                    status: "passed",
                  },
                ],
              },
            ],
          },
          {
            title: "create Company: form fill, submit, row appears",
            ok: true,
            tests: [
              {
                results: [
                  {
                    status: "passed",
                  },
                ],
              },
            ],
          },
          {
            title: "update Company: edit form, change field, save",
            ok: false,
            tests: [
              {
                results: [
                  {
                    status: "failed",
                    error: { message: "row did not update" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    stats: {
      expected: 3,
      unexpected: 1,
      flaky: 0,
      skipped: 0,
    },
    errors: [],
  };

  let execCallCount = 0;

  const fakeExec: Exec = async () => {
    execCallCount++;

    return {
      code: 0,
      stdout: JSON.stringify(report),
      stderr: "",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  expect(outcome.ok).toBe(false);
  expect(outcome.results.length).toBe(3);
  expect(outcome.results[0]).toEqual({
    entity: "company",
    step: "nav",
    ok: true,
    detail: "pass",
  });
  expect(outcome.results[2]).toEqual({
    entity: "company",
    step: "update",
    ok: false,
    detail: "row did not update",
  });
  expect(outcome.detail).toBe("row did not update");
  expect(execCallCount).toBe(1);
});

test("runner: all-pass nested report returns ok=true", async () => {
  const report = {
    suites: [
      {
        title: "e2e/company.spec.ts",
        specs: [
          {
            title: "navigate to company list via sidebar",
            ok: true,
            tests: [{ results: [{ status: "passed" }] }],
          },
          {
            title: "company list is present or empty state shown",
            ok: true,
            tests: [{ results: [{ status: "passed" }] }],
          },
          {
            title: "create Company: form fill, submit, row appears",
            ok: true,
            tests: [{ results: [{ status: "passed" }] }],
          },
          {
            title: "Company persists after page reload",
            ok: true,
            tests: [{ results: [{ status: "passed" }] }],
          },
          {
            title: "update Company: edit form, change field, save",
            ok: true,
            tests: [{ results: [{ status: "passed" }] }],
          },
          {
            title: "delete Company: row delete, confirm, row gone",
            ok: true,
            tests: [{ results: [{ status: "passed" }] }],
          },
        ],
      },
    ],
    stats: { expected: 6, unexpected: 0, flaky: 0, skipped: 0 },
    errors: [],
  };

  const fakeExec: Exec = async () => ({
    code: 0,
    stdout: JSON.stringify(report),
    stderr: "",
  });

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  expect(outcome.ok).toBe(true);
  expect(outcome.detail).toBeUndefined();
  expect(outcome.infraError).toBeUndefined();
});

test("runner: browser-launch error detected as infraError, retried", async () => {
  let execCallCount = 0;

  const fakeExec: Exec = async () => {
    execCallCount++;

    return {
      code: 1,
      stdout: "",
      stderr: "Executable doesn't exist: /path/to/chromium",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  expect(outcome.ok).toBe(false);
  expect(outcome.infraError).toContain("Executable doesn't exist");
  expect(outcome.results.length).toBe(0);
  expect(execCallCount).toBe(3); // 3 attempts (0, 1, 2)
});

test("runner: ECONNREFUSED detected as infraError", async () => {
  let execCallCount = 0;

  const fakeExec: Exec = async () => {
    execCallCount++;

    return {
      code: 1,
      stdout: "",
      stderr: "ECONNREFUSED: The UI server is not running",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  expect(outcome.ok).toBe(false);
  expect(outcome.infraError).toBeDefined();
  expect(execCallCount).toBe(3);
});

test("runner: assertion failure is not retried", async () => {
  let execCallCount = 0;

  const fakeExec: Exec = async () => {
    execCallCount++;

    return {
      code: 1,
      stdout: JSON.stringify({
        suites: [
          {
            title: "e2e/company.spec.ts",
            specs: [
              {
                title: "create Company: form fill, submit, row appears",
                ok: false,
                tests: [
                  {
                    results: [
                      {
                        status: "failed",
                        error: { message: "Row did not appear" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
        errors: [],
      }),
      stderr: "",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  expect(outcome.ok).toBe(false);
  expect(outcome.infraError).toBeUndefined();
  expect(execCallCount).toBe(1); // No retry
});

test("runner: empty JSON/no output after infra retries becomes infraError", async () => {
  let execCallCount = 0;

  const fakeExec: Exec = async () => {
    execCallCount++;

    return {
      code: 1,
      stdout: "",
      stderr: "Executable doesn't exist",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  expect(outcome.ok).toBe(false);
  expect(outcome.infraError).toBeDefined();
  expect(outcome.results.length).toBe(0);
  expect(execCallCount).toBe(3); // Retried up to 3 times
});

test("runChain: returns summarized outcome across entities", async () => {
  const secondEntity: IEntityAcceptance = {
    ...testEntity,
    id: "Contact",
    key: "contact",
    nav: "Contacts",
    parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
  };

  const fakeExec: Exec = async (_argv) => {
    const report = {
      suites: [
        {
          title: "Full Relational Chain: Company → Contact",
          specs: [
            {
              title: "create root entity: Company",
              ok: true,
              tests: [{ results: [{ status: "passed" }] }],
            },
            {
              title: "create child entity: Contact with parent linkage",
              ok: true,
              tests: [{ results: [{ status: "passed" }] }],
            },
          ],
        },
      ],
      stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0 },
      errors: [],
    };

    return {
      code: 0,
      stdout: JSON.stringify(report),
      stderr: "",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const spec = {
    entities: [testEntity, secondEntity],
  };
  const ctx = createTestCtx();

  const outcome = await runner.runChain(spec, ctx);

  // Both entities passed, so overall ok should be true
  expect(outcome.ok).toBe(true);
  expect(outcome.results.length).toBeGreaterThan(0);
});

test("runChain: stops on first infra error", async () => {
  let execCallCount = 0;

  const fakeExec: Exec = async () => {
    execCallCount++;

    // Chain spec execution gets infra error
    return {
      code: 1,
      stdout: "",
      stderr: "Executable doesn't exist",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const spec = {
    entities: [testEntity, { ...testEntity, key: "contact", id: "Contact" }],
  };
  const ctx = createTestCtx();

  const outcome = await runner.runChain(spec, ctx);

  expect(outcome.infraError).toBeDefined();
  expect(outcome.ok).toBe(false);
  // Retried up to 3 times on chain spec
  expect(execCallCount).toBe(3);
});

test("runner: passes correct env vars (PLAYWRIGHT_PORT, VITE_API_BASE) and inherits process.env", async () => {
  let capturedEnv: Record<string, string | undefined> | undefined;

  const fakeExec: Exec = async (_argv, opts) => {
    capturedEnv = opts.env;

    return {
      code: 0,
      stdout: JSON.stringify({
        suites: [
          {
            title: "e2e/company.spec.ts",
            specs: [
              {
                title: "navigate to company list via sidebar",
                ok: true,
                tests: [{ results: [{ status: "passed" }] }],
              },
            ],
          },
        ],
        stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
        errors: [],
      }),
      stderr: "",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  await runner.run(testEntity, ctx);

  expect(capturedEnv).toBeDefined();
  expect(capturedEnv?.PLAYWRIGHT_PORT).toBe("7331");
  expect(capturedEnv?.VITE_API_BASE).toBe("http://localhost:3000");
  // Verify that process.env variables are preserved (e.g., PATH)
  expect(capturedEnv?.PATH).toBeDefined();
});

test("runner: extracts port from URL with non-standard ports", async () => {
  let capturedEnv: Record<string, string | undefined> | undefined;

  const fakeExec: Exec = async (_argv, opts) => {
    capturedEnv = opts.env;

    return {
      code: 0,
      stdout: JSON.stringify({
        suites: [
          {
            title: "e2e/company.spec.ts",
            specs: [
              {
                title: "navigate to company list via sidebar",
                ok: true,
                tests: [{ results: [{ status: "passed" }] }],
              },
            ],
          },
        ],
        stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
        errors: [],
      }),
      stderr: "",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx({
    apiBase: "http://localhost:5432",
    uiBase: "http://localhost:9999",
  });

  await runner.run(testEntity, ctx);

  expect(capturedEnv?.PLAYWRIGHT_PORT).toBe("9999");
});
