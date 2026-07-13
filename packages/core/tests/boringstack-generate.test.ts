import { test, expect, describe } from "bun:test";
import {
  generateResource,
  generateFeature,
} from "../src/loop/boringstack/generate";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const recorder = () => {
  const calls: string[][] = [];

  const exec = async (argv: readonly string[]) => {
    calls.push([...argv]);

    return { code: 0, stdout: "", stderr: "" };
  };

  return { calls, exec };
};

async function createTestEnv(): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), "boringstack-test-"));

  const apiConfigDir = join(tmpDir, "apps/api/src/config");
  const routesDir = join(apiConfigDir, "routes");
  const appDir = join(apiConfigDir, "app");
  const swaggerDir = join(apiConfigDir, "swagger");

  const dirs = [routesDir, appDir, swaggerDir];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  const emptyRoutesFile = join(routesDir, "routes.ts");
  const emptyAppFile = join(appDir, "app.ts");
  const emptySwaggerFile = join(swaggerDir, "swagger.ts");

  await writeFile(
    emptyRoutesFile,
    'import { Router } from "express";\n\nexport const routes = {\n};\n',
    "utf-8"
  );
  await writeFile(
    emptyAppFile,
    "const routes = {};\n\nconst app = elysia()\n  .use(routes)\n  .compile();\n",
    "utf-8"
  );
  await writeFile(
    emptySwaggerFile,
    'export const swagger = [\n  { name: "Example", description: "Example" }\n  ],\n];\n',
    "utf-8"
  );

  return tmpDir;
}

describe("generateResource", () => {
  test("runs new:resource, formats, then db:push", async () => {
    const tmpDir = await createTestEnv();

    try {
      const { calls, exec } = recorder();

      await generateResource(tmpDir, "Invoice", exec);
      const joined = calls.map((c) => c.join(" "));

      expect(
        joined.some((c) => c.includes("new:resource") && c.includes("Invoice"))
      ).toBe(true);
      expect(joined.findIndex((c) => c.includes("db:push"))).toBeGreaterThan(
        joined.findIndex((c) => c.includes("new:resource"))
      );
      // Formats via BoringStack's pinned `bun run format` (NOT bunx-latest prettier).
      expect(joined.some((c) => c.includes("run format"))).toBe(true);
      expect(joined.some((c) => c.includes("bunx"))).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws when a generator command fails", async () => {
    const tmpDir = await createTestEnv();

    try {
      const exec = async (
        _argv: readonly string[],
        _opts: { cwd: string }
      ) => ({ code: 1, stdout: "", stderr: "boom" });

      await expect(generateResource(tmpDir, "Invoice", exec)).rejects.toThrow(
        /boom/
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("generateResource idempotency (retry-safe)", () => {
  test("skips new:resource + wiring when the resource already exists, still re-syncs", async () => {
    const tmpDir = await createTestEnv();

    try {
      // Simulate a prior attempt: the resource dir already exists on disk.
      await mkdir(join(tmpDir, "apps/api/src/api/project"), {
        recursive: true,
      });

      const { calls, exec } = recorder();

      await generateResource(tmpDir, "Project", exec);
      const joined = calls.map((c) => c.join(" "));

      // new:resource would CRASH on an existing dir — it must be skipped on retry…
      expect(joined.some((c) => c.includes("new:resource"))).toBe(false);
      // …but the downstream sync still runs so a fix is reflected.
      expect(joined.some((c) => c.includes("run format"))).toBe(true);
      expect(joined.some((c) => c.includes("db:push"))).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("generateFeature", () => {
  test("runs new:feature then generate:api in apps/ui", async () => {
    const { calls, exec } = recorder();

    await generateFeature("/repo", "Dashboard", exec);
    const joined = calls.map((c) => c.join(" "));

    expect(
      joined.some((c) => c.includes("new:feature") && c.includes("Dashboard"))
    ).toBe(true);
    expect(joined.some((c) => c.includes("generate:api"))).toBe(true);
    expect(joined.findIndex((c) => c.includes("new:feature"))).toBeLessThan(
      joined.findIndex((c) => c.includes("generate:api"))
    );
    // Waits for the API to be serving its reloaded spec BEFORE generate:api fetches it.
    expect(joined.some((c) => c.includes("curl"))).toBe(true);
    expect(joined.findIndex((c) => c.includes("curl"))).toBeLessThan(
      joined.findIndex((c) => c.includes("generate:api"))
    );
  });

  test("throws when a feature command fails", async () => {
    const exec = async () => ({
      code: 1,
      stdout: "",
      stderr: "feature gen failed",
    });

    await expect(generateFeature("/repo", "Dashboard", exec)).rejects.toThrow(
      /feature gen failed/
    );
  });

  test("does NOT throw and SKIPS generate:api when the API never comes ready", async () => {
    // A persistently-down API (curl readiness loop → exit 1) is almost always the
    // model's own in-progress schema/code crashing the dev server. generateFeature
    // must NOT abort the build — it skips the client sync so the GATE surfaces the
    // real compiler error, instead of every later attempt dead-ending at readiness.
    const calls: string[][] = [];

    const exec = async (argv: readonly string[]) => {
      calls.push([...argv]);
      const cmd = argv.join(" ");

      // new:feature succeeds; the curl readiness probe never succeeds.
      return cmd.includes("curl")
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    };

    // Must resolve, not reject.
    await generateFeature("/repo", "Dashboard", exec);

    const joined = calls.map((c) => c.join(" "));

    expect(joined.some((c) => c.includes("curl"))).toBe(true);
    // generate:api is skipped because the API isn't serving.
    expect(joined.some((c) => c.includes("generate:api"))).toBe(false);
  });
});
