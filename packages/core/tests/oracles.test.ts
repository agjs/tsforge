import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLcovCoverage,
  coverageFloor,
} from "../scripts/test-coverage-check";
import { bootConfig, pollUntilReady } from "../scripts/boot-check";
import { buildGate } from "../src/detect-gate";
import { serveEphemeral } from "../src/lib/serve";

describe("test-coverage oracle", () => {
  test("parseLcovCoverage sums line + function coverage and takes the weaker", () => {
    const lcov = [
      "TN:",
      "SF:src/m.ts",
      "FNF:2",
      "FNH:1",
      "LF:4",
      "LH:4",
      "end_of_record",
    ].join("\n");
    const cov = parseLcovCoverage(lcov);

    expect(cov.linePct).toBe(100);
    expect(cov.funcPct).toBe(50);
    expect(cov.pct).toBe(50); // an uncovered function can't hide behind line counts
  });

  test("coverageFloor parses env, defaulting sensibly", () => {
    expect(coverageFloor("85")).toBe(85);
    expect(coverageFloor("1")).toBe(80); // truthy-but-useless → default
    expect(coverageFloor(undefined)).toBe(80);
    expect(coverageFloor("nonsense")).toBe(80);
  });
});

describe("boot oracle", () => {
  test("bootConfig is null without TSFORGE_BOOT, populated with it", () => {
    expect(bootConfig({})).toBeNull();
    const cfg = bootConfig({
      TSFORGE_BOOT: "bun run start",
      TSFORGE_BOOT_URL: "http://localhost:4000/health",
    });

    expect(cfg?.command).toBe("bun run start");
    expect(cfg?.url).toBe("http://localhost:4000/health");
    expect(cfg?.timeoutMs).toBe(15000);
  });

  test("pollUntilReady returns the status of a live server", async () => {
    const server = await serveEphemeral({ fetch: () => new Response("ok") });

    try {
      const status = await pollUntilReady(
        `http://localhost:${String(server.port)}/`,
        5000
      );

      expect(status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("pollUntilReady times out when nothing answers (no real waiting)", async () => {
    let clock = 0;
    const now = (): number => clock;

    const sleep = (ms: number): Promise<void> => {
      clock += ms;

      return Promise.resolve();
    };

    // Port 1 is privileged/unused — fetch fails fast every poll.
    const status = await pollUntilReady(
      "http://localhost:1/",
      1000,
      now,
      sleep
    );

    expect(status).toBeNull();
  });
});

describe("gate wiring for opt-in oracles", () => {
  let dir = "";

  afterEach(() => {
    if (dir.length > 0) {
      rmSync(dir, { recursive: true, force: true });
    }

    delete process.env.TSFORGE_COVERAGE;
    delete process.env.TSFORGE_BOOT;
  });

  test("buildGate appends coverage + boot steps only when their env is set", async () => {
    dir = mkdtempSync(join(tmpdir(), "tsforge-gate-oracles-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));

    const off = await buildGate(dir, []);

    expect(off.command).not.toContain("test-coverage-check.ts");
    expect(off.command).not.toContain("boot-check.ts");

    process.env.TSFORGE_COVERAGE = "80";
    process.env.TSFORGE_BOOT = "bun run start";

    const on = await buildGate(dir, []);

    expect(on.command).toContain("test-coverage-check.ts");
    expect(on.command).toContain("boot-check.ts");
    expect(on.label).toContain("test coverage");
    expect(on.label).toContain("boot smoke");
  });

  // P3 (review): boot-check left the server's stdout piped-but-unread and only
  // drained stderr on failure. A server that logs a lot on boot would fill the pipe
  // and block on write → never answer → boot-check times out. With stdout ignored +
  // stderr background-drained, a chatty-but-healthy server still answers 200.
  test("boot-check survives a server that floods its output then answers", async () => {
    // Free port: serveEphemeral binds 127.0.0.1; read the port, then release it.
    const probe = await serveEphemeral({ fetch: () => new Response("ok") });
    const port = probe.port;

    await probe.stop(true);

    const tmp = mkdtempSync(join(tmpdir(), "tsforge-boot-hang-"));

    try {
      const serverFile = join(tmp, "server.ts");

      // Flood stdout + stderr with far more than a pipe buffer (~64KB) BEFORE
      // serving, then answer 200 and stay up.
      writeFileSync(
        serverFile,
        [
          'const big = "x".repeat(300000);',
          "process.stderr.write(big);",
          "process.stdout.write(big);",
          `Bun.serve({ port: ${String(port)}, hostname: "127.0.0.1", fetch: () => new Response("ok") });`,
        ].join("\n")
      );

      const bootCheck = join(import.meta.dir, "..", "scripts", "boot-check.ts");
      const proc = Bun.spawn(["bun", bootCheck], {
        cwd: tmp,
        env: {
          ...process.env,
          TSFORGE_BOOT: `bun ${serverFile}`,
          TSFORGE_BOOT_URL: `http://127.0.0.1:${String(port)}/`,
          TSFORGE_BOOT_TIMEOUT: "8000",
        },
        stdout: "ignore",
        stderr: "ignore",
      });

      // On the old code this would time out (exit 1); now the server answers → 0.
      expect(await proc.exited).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 25000);
});
