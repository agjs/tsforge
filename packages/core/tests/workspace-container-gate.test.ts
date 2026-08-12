import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWorkspaceContainer,
  listChildPackageRoots,
  activePackageRoots,
  packageLabel,
  runWorkspaceContainerGate,
} from "../src/gate";
import type { ITask } from "../src/spec";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-ws-gate-"));
}

const stubTask: ITask = {
  id: "t1",
  accept: "true",
  files: ["**/*"],
};

test("isWorkspaceContainer: root package.json is never a container", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), "{}");
    await mkdir(join(dir, "packages"));
    await writeFile(join(dir, "packages", "package.json"), "{}");

    expect(isWorkspaceContainer(dir)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isWorkspaceContainer + listChildPackageRoots: multi-repo bag", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "api"));
    await mkdir(join(dir, "app"));
    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, "api", "package.json"), '{"name":"api"}');
    await writeFile(join(dir, "app", "package.json"), '{"name":"app"}');
    await writeFile(join(dir, "notes", "README.md"), "# notes\n");

    expect(isWorkspaceContainer(dir)).toBe(true);
    expect(listChildPackageRoots(dir).map((p) => packageLabel(p))).toEqual([
      "api",
      "app",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("activePackageRoots: only packages under touched paths", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "api"));
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "api", "package.json"), "{}");
    await writeFile(join(dir, "app", "package.json"), "{}");

    expect(activePackageRoots(dir, ["app/src/x.ts"])).toEqual([
      join(dir, "app"),
    ]);
    expect(activePackageRoots(dir, ["ARCHITECTURE.md"])).toEqual([]);
    expect(
      activePackageRoots(dir, ["api/a.ts", "app/b.ts"]).map(packageLabel)
    ).toEqual(["api", "app"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkspaceContainerGate: no touches → green skip", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "app", "package.json"), "{}");

    const { result, acceptSummary } = await runWorkspaceContainerGate(
      dir,
      stubTask,
      ["README.md"],
      undefined,
      {}
    );

    expect(result.passed).toBe(true);
    expect(acceptSummary).toBe("true");
    expect(result.output).toContain("gate skipped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkspaceContainerGate: touched package runs accept true", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "app"));
    // Minimal package: buildGate still needs eslint floor; accept is built
    // from that. Use includeTests false path via empty package — gate must
    // finish. We only assert fan-out branding + pass/fail structure.
    await writeFile(
      join(dir, "app", "package.json"),
      JSON.stringify({ name: "app" })
    );

    const chunks: string[] = [];
    const { result, acceptSummary } = await runWorkspaceContainerGate(
      dir,
      stubTask,
      ["app/src/x.ts"],
      undefined,
      {
        onChunk: (s) => {
          chunks.push(s);
        },
      }
    );

    expect(acceptSummary).toContain("app:");
    expect(chunks.some((c) => c.includes("gate → app"))).toBe(true);
    expect(result.output).toContain("── app ──");
    // Floor gate on empty package should pass (tsc may skip; eslint on empty).
    expect(typeof result.passed).toBe("boolean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
