import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Exec } from "../src/loop/boringstack/exec";
import {
  makeBoringstackAcceptanceRunner,
  processExecResult,
} from "../src/loop/boringstack/acceptance/e2e-runner";
import { chainCreateTitle } from "../src/loop/boringstack/acceptance/e2e-generator";
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
  negatives: [],
  acceptanceCheck: "create a company",
};

const CREATE_TITLE = "create Company: form fill, submit, row appears";

function parseableReport(ok: boolean): string {
  return JSON.stringify({
    suites: [
      {
        title: "e2e/company.spec.ts",
        suites: [],
        specs: [
          {
            title: CREATE_TITLE,
            ok,
            tests: [
              {
                results: [
                  {
                    status: ok ? "passed" : "failed",
                    ...(ok ? {} : { error: { message: "boom" } }),
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    stats: { expected: 1, unexpected: ok ? 0 : 1, flaky: 0, skipped: 0 },
    errors: [],
  });
}

test("processExecResult threads the parsed results back (exit 0, parseable)", () => {
  const res = processExecResult(
    { code: 0, stdout: parseableReport(true), stderr: "" },
    testEntity,
    ["create"]
  );

  // The parse happens once here and is returned so run() need not re-parse.
  expect(res.parseResult.length).toBeGreaterThan(0);
  expect(res.parseResult.some((r) => r.step === "create" && r.ok)).toBe(true);
  expect(res.outcome).toBeDefined();
});

test("processExecResult threads parsed results even on a nonzero exit (diagnostics)", () => {
  const res = processExecResult(
    { code: 1, stdout: parseableReport(false), stderr: "" },
    testEntity,
    ["create"]
  );

  // Real failure: results are preserved (not discarded) for steer/diagnostics.
  expect(res.parseResult.length).toBeGreaterThan(0);
  expect(res.parseResult.some((r) => r.step === "create")).toBe(true);
});

test("processExecResult returns empty parseResult when stdout is unparseable", () => {
  const res = processExecResult(
    { code: 1, stdout: "", stderr: "some error" },
    testEntity,
    ["create"]
  );

  expect(res.parseResult.length).toBe(0);
});

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

test("runner: forces PLAYWRIGHT_REUSE_SERVER=true so Playwright reuses the dockerized ui-dev, never self-spawns", async () => {
  // The scaffold gates reuse on `!CI`; a CI=1 build env flips it OFF, so Playwright tries to
  // start its own host dev server, collides with the running container on the UI port, and exits
  // with ZERO tests run ("port already used") — the harness then reads a GREEN feature as a failed
  // acceptance and parks it (build22–26). Forcing reuse ON in the runner's env prevents the spawn.
  let capturedEnv: Record<string, string> | undefined;
  const passReport = {
    suites: [],
    stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
    errors: [],
  };

  const fakeExec: Exec = async (_argv, opts) => {
    capturedEnv = opts.env;

    return { code: 0, stdout: JSON.stringify(passReport), stderr: "" };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);

  await runner.run(testEntity, createTestCtx());

  expect(capturedEnv?.PLAYWRIGHT_REUSE_SERVER).toBe("true");
  // still points Playwright at the dockerized UI port (from ctx.uiBase), not a new server.
  expect(capturedEnv?.PLAYWRIGHT_PORT).toBe("7331");
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
  const secondEntity = {
    ...testEntity,
    key: "contact",
    id: "Contact",
    parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
  };
  const spec = {
    entities: [testEntity, secondEntity],
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

test("runner: cleans up generated spec and auth-helper after successful run", async () => {
  const fakeExec: Exec = async () => {
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

  const specFilePath = join(ctx.cwd, "apps/ui/e2e/_acceptance/company.spec.ts");
  const authPath = join(ctx.cwd, "apps/ui/e2e/_acceptance/auth-helper.ts");

  await runner.run(testEntity, ctx);

  // Files should be cleaned up after the run
  expect(existsSync(specFilePath)).toBe(false);
  expect(existsSync(authPath)).toBe(false);
});

test("runner: cleans up generated files even on infra error", async () => {
  const fakeExec: Exec = async () => {
    return {
      code: 1,
      stdout: "",
      stderr: "Executable doesn't exist",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const specFilePath = join(ctx.cwd, "apps/ui/e2e/_acceptance/company.spec.ts");
  const authPath = join(ctx.cwd, "apps/ui/e2e/_acceptance/auth-helper.ts");

  // Pre-populate files to simulate previous run
  mkdirSync(join(ctx.cwd, "apps/ui/e2e/_acceptance"), { recursive: true });
  writeFileSync(specFilePath, "generated spec");
  writeFileSync(authPath, "generated auth");

  expect(existsSync(specFilePath)).toBe(true);
  expect(existsSync(authPath)).toBe(true);

  await runner.run(testEntity, ctx);

  // Files should be cleaned up even after infra error
  expect(existsSync(specFilePath)).toBe(false);
  expect(existsSync(authPath)).toBe(false);
});

test("runChain: cleans up generated chain spec and auth-helper after run", async () => {
  const fakeExec: Exec = async () => {
    return {
      code: 0,
      stdout: JSON.stringify({
        suites: [
          {
            title: "Full Relational Chain",
            specs: [
              {
                title: "create root entity: Company",
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
  const spec = {
    entities: [testEntity],
  };
  const ctx = createTestCtx();

  const chainPath = join(ctx.cwd, "apps/ui/e2e/_acceptance/chain.spec.ts");
  const authPath = join(ctx.cwd, "apps/ui/e2e/_acceptance/auth-helper.ts");

  await runner.runChain(spec, ctx);

  // Files should be cleaned up after the run
  expect(existsSync(chainPath)).toBe(false);
  expect(existsSync(authPath)).toBe(false);
});

test("runner: nonzero exit with parseable JSON but ECONNREFUSED stderr is retried (infra, not feature-fail)", async () => {
  let execCallCount = 0;

  const fakeExec: Exec = async () => {
    execCallCount++;

    // Playwright produces parseable JSON (tests ran) but exits with code 1
    // AND stderr contains ECONNREFUSED (infrastructure error)
    return {
      code: 1,
      stdout: JSON.stringify({
        suites: [
          {
            title: "e2e/company.spec.ts",
            specs: [
              {
                title: "create Company: form fill, submit, row appears",
                ok: true,
                tests: [{ results: [{ status: "passed" }] }],
              },
            ],
          },
        ],
        stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
        errors: [],
      }),
      stderr: "ECONNREFUSED: Failed to connect to API server",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  // Should be classified as infra error, not feature failure
  expect(outcome.ok).toBe(false);
  expect(outcome.infraError).toBeDefined();
  // Infra errors are retried up to 3 times
  expect(execCallCount).toBe(3);
});

test("FIX 1: entity code:1 + parseable report with failing assertion preserves results + detail", async () => {
  const fakeExec: Exec = async () => {
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
                        error: {
                          message: "Expected row to appear but timeout",
                        },
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

  // Should NOT be marked as infra error (no infra indicators)
  expect(outcome.infraError).toBeUndefined();
  // Results must be preserved (not empty)
  expect(outcome.results.length).toBeGreaterThan(0);
  // Detail must be the assertion message (NOT "exited with code 1")
  expect(outcome.detail).toContain("Expected row to appear but timeout");
  expect(outcome.detail).not.toContain("exited with code");
});

test("FIX 1: chain code:1 + parseable report preserves results + assertion detail", async () => {
  const secondEntity: IEntityAcceptance = {
    ...testEntity,
    id: "Contact",
    key: "contact",
    nav: "Contacts",
    parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
  };

  const fakeExec: Exec = async () => {
    return {
      code: 1,
      stdout: JSON.stringify({
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
                ok: false,
                tests: [
                  {
                    results: [
                      {
                        status: "failed",
                        error: {
                          message: "Parent cell did not show parent value",
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        stats: { expected: 2, unexpected: 1, flaky: 0, skipped: 0 },
        errors: [],
      }),
      stderr: "",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const spec = {
    entities: [testEntity, secondEntity],
  };
  const ctx = createTestCtx();

  const outcome = await runner.runChain(spec, ctx);

  // Should NOT be infra error
  expect(outcome.infraError).toBeUndefined();
  // Results must be preserved
  expect(outcome.results.length).toBeGreaterThan(0);
  // Detail must contain the assertion message (NOT "no valid JSON output")
  expect(outcome.detail).toContain("Parent cell did not show parent value");
  expect(outcome.detail).not.toContain("no valid JSON output");
});

test("FIX 2: per-test error with net::ERR_CONNECTION is NOT classified as infra (no top-level error)", async () => {
  let execCallCount = 0;

  const fakeExec: Exec = async () => {
    execCallCount++;

    // Playwright produces a report with a per-test error containing net::ERR_CONNECTION
    // but NO top-level errors (so it's a feature failure, not infra)
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
                        error: {
                          message:
                            "net::ERR_CONNECTION_REFUSED connection refused",
                        },
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

  // Should be classified as REAL failure (feature-red), NOT infra
  // Per-test errors must NOT trigger infra classification
  expect(outcome.infraError).toBeUndefined();
  expect(outcome.ok).toBe(false);
  // No retry should happen
  expect(execCallCount).toBe(1);
});

test("FIX 2: top-level report error is classified as infra", async () => {
  let execCallCount = 0;

  const fakeExec: Exec = async () => {
    execCallCount++;

    // Top-level error (global setup failure) — classified as infra
    return {
      code: 1,
      stdout: JSON.stringify({
        suites: [],
        stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
        errors: [{ message: "ECONNREFUSED: Failed to connect during setup" }],
      }),
      stderr: "",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  // Top-level ECONNREFUSED → infra error
  expect(outcome.infraError).toBeDefined();
  // Should retry
  expect(execCallCount).toBe(3);
});

test("FIX 6: infra-classified run with parseable results preserves results and infraError detail", async () => {
  const fakeExec: Exec = async () => {
    // Infra failure but with valid parsed results (e.g., some tests ran, then infrastructure failed)
    return {
      code: 1,
      stdout: JSON.stringify({
        suites: [
          {
            title: "Company",
            specs: [
              {
                title: "navigate to company list via sidebar",
                ok: true,
                tests: [
                  {
                    results: [{ status: "passed" }],
                  },
                ],
              },
            ],
          },
        ],
        stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
      }),
      stderr: "ECONNREFUSED: connection timeout after partial execution",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  // FIX 6: even though classified as infra, preserve the parsed results
  expect(outcome.infraError).toBeDefined();
  expect(outcome.infraError).toContain("ECONNREFUSED");
  // CRITICAL: results must be preserved (not empty [])
  expect(outcome.results.length).toBeGreaterThan(0);
  const firstResult = outcome.results[0];

  if (firstResult) {
    expect(firstResult.step).toBe("nav");
    expect(firstResult.ok).toBe(true);
  }
});

test("FIX A: chainCreateTitle generates canonical titles for all kinds", () => {
  const entityId = "Company";

  // All three kinds should generate distinct titles
  const rootTitle = chainCreateTitle("root", entityId);
  const childTitle = chainCreateTitle("child", entityId);
  const standaloneTitle = chainCreateTitle("standalone", entityId);

  expect(rootTitle).toBe("create root entity: Company");
  expect(childTitle).toBe("create child entity: Company with parent linkage");
  expect(standaloneTitle).toBe("create entity: Company (no parent linkage)");
});

test("FIX A: parseStep recognizes all chain-create titles", async () => {
  const fakeExec: Exec = async () => ({
    code: 0,
    stdout: JSON.stringify({
      suites: [
        {
          title: "Full Relational Chain",
          specs: [
            {
              title: chainCreateTitle("root", testEntity.id),
              ok: true,
              tests: [{ results: [{ status: "passed" }] }],
            },
            {
              title: chainCreateTitle("child", testEntity.id),
              ok: true,
              tests: [{ results: [{ status: "passed" }] }],
            },
            {
              title: chainCreateTitle("standalone", testEntity.id),
              ok: true,
              tests: [{ results: [{ status: "passed" }] }],
            },
          ],
        },
      ],
      stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 0 },
      errors: [],
    }),
    stderr: "",
  });

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const spec = { entities: [testEntity] };
  const ctx = createTestCtx();

  const outcome = await runner.runChain(spec, ctx);

  // All three create steps should be recognized and pass
  expect(outcome.ok).toBe(true);
  expect(outcome.results.length).toBe(3);
  expect(outcome.results.every((r) => r.step === "create")).toBe(true);
});

test("FIX 1b: runner preserves earlier parsed result when later attempt is unparseable", async () => {
  let attemptCount = 0;

  const fakeExec: Exec = async () => {
    attemptCount++;

    if (attemptCount === 1) {
      // First attempt: parseable JSON with results (infra error in stderr)
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
        stderr: "ECONNREFUSED: connection timeout",
      };
    }

    if (attemptCount === 2) {
      // Second attempt: still infra error, unparseable (empty stdout)
      return {
        code: 1,
        stdout: "",
        stderr: "ECONNREFUSED: infrastructure failure",
      };
    }

    // Third attempt: still unparseable
    return {
      code: 1,
      stdout: "",
      stderr: "ECONNREFUSED: final infra failure",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  // Must be classified as infra error after 3 attempts
  expect(outcome.infraError).toBeDefined();
  // CRITICAL: results from the first (parseable) attempt must be preserved
  expect(outcome.results.length).toBeGreaterThan(0);
  expect(outcome.results[0]?.step).toBe("create");
  expect(outcome.results[0]?.detail).toBe("Row did not appear");
});

test("FIX 1b: runner overwrites earlier result when later attempt is valid-empty []", async () => {
  let attemptCount = 0;

  const fakeExec: Exec = async () => {
    attemptCount++;

    if (attemptCount === 1) {
      // First attempt: parseable JSON with one result + infra error in stderr
      return {
        code: 1,
        stdout: JSON.stringify({
          suites: [
            {
              title: "e2e/company.spec.ts",
              specs: [
                {
                  title: "create Company: form fill, submit, row appears",
                  ok: true,
                  tests: [{ results: [{ status: "passed" }] }],
                },
              ],
            },
          ],
          stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
          errors: [],
        }),
        stderr: "ECONNREFUSED: connection timeout",
      };
    }

    // Second attempt: parseable JSON but no matching test specs (empty results, still infra error)
    return {
      code: 1,
      stdout: JSON.stringify({
        suites: [
          {
            title: "e2e/company.spec.ts",
            specs: [],
          },
        ],
        stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
        errors: [],
      }),
      stderr: "ECONNREFUSED: connection still failing",
    };
  };

  const runner = makeBoringstackAcceptanceRunner(fakeExec);
  const ctx = createTestCtx();

  const outcome = await runner.run(testEntity, ctx);

  // Must be classified as infra error
  expect(outcome.infraError).toBeDefined();
  // CRITICAL: results must be the LATEST valid-empty [] parse (empty array from second attempt)
  // NOT the earlier result with "create" from first attempt
  expect(outcome.results.length).toBe(0);
});
