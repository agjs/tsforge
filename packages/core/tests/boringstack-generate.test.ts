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
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws when a generator command fails", async () => {
    const tmpDir = await createTestEnv();

    try {
      const exec = async () => ({ code: 1, stdout: "", stderr: "boom" });

      await expect(generateResource(tmpDir, "Invoice", exec)).rejects.toThrow(
        /boom/
      );
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
});
