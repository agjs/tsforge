import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { makeFileLinter, buildGate } from "../src/detect-gate";
import { tmpdir } from "node:os";

describe("gate with stack-aware rule packs", () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for test fixtures
    tempDir = join(tmpdir(), `tsforge-test-${Date.now()}`);
  });

  afterEach(() => {
    // Cleanup is handled by the test runner
  });

  test("buildGate includes TSFORGE_PACKS env var when packs are provided", async () => {
    const gate = await buildGate(tempDir, ["drizzle", "elysia"]);

    expect(gate.command).toContain("TSFORGE_PACKS=drizzle,elysia");
    expect(gate.command).toContain("bun");
  });

  test("buildGate does not include TSFORGE_PACKS when no packs are provided", async () => {
    const gate = await buildGate(tempDir, []);

    expect(gate.command).not.toContain("TSFORGE_PACKS");
    expect(gate.command).toContain("bun");
  });

  test("buildGate uses bun to run eslint", async () => {
    const gate = await buildGate(tempDir);

    expect(gate.command).toContain("bun");
    expect(gate.command).toContain("eslint");
  });

  test("makeFileLinter accepts packIds parameter", async () => {
    const linter = makeFileLinter("core", tempDir, ["env-access"]);

    expect(linter).toBeDefined();
    expect(typeof linter).toBe("function");
  });

  test("makeFileLinter without packs works", async () => {
    const linter = makeFileLinter("core", tempDir);

    expect(linter).toBeDefined();
    expect(typeof linter).toBe("function");
  });
});
