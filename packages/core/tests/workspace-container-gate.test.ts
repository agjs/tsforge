import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWorkspaceContainer,
  listChildPackageRoots,
  activePackageRoots,
  makeWorkspaceFileLinter,
  owningPackageRoot,
  packageLabel,
  runWorkspaceContainerGate,
  unpackagedCodePaths,
} from "../src/gate";
import { runShellCommand } from "../src/lib/fs";
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

    const { result, accept } = await runWorkspaceContainerGate(
      dir,
      stubTask,
      ["README.md"],
      undefined,
      {}
    );

    expect(result.passed).toBe(true);
    expect(accept).toBe("true");
    expect(result.output).toContain("gate skipped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkspaceContainerGate: touched package gates in its own cwd", async () => {
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
    const run = await runWorkspaceContainerGate(
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

    expect(chunks.some((c) => c.includes("gate → app"))).toBe(true);
    expect(run.result.output).toContain("── app ──");
    expect(run.label).toBe("app");
    // Identity must name the packs that actually ran, not "(none)".
    expect(run.packs).toContain("generic-ts");
    // Floor gate on empty package should pass (tsc may skip; eslint on empty).
    expect(typeof run.result.passed).toBe("boolean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkspaceContainerGate: accept is a runnable command, not a label", async () => {
  const dir = await tempDir();

  try {
    // A space in the package name proves the path is quoted, not just pasted.
    await mkdir(join(dir, "my app"));
    await writeFile(
      join(dir, "my app", "package.json"),
      JSON.stringify({ name: "my-app" })
    );

    const { accept } = await runWorkspaceContainerGate(
      dir,
      stubTask,
      ["my app/src/x.ts"],
      undefined,
      {}
    );

    // Runs the package's own gate from the container root.
    expect(accept).toContain(`(cd '${join(dir, "my app")}' &&`);
    // No label leakage: `my app: tsc …` would be a shell parse error.
    expect(accept).not.toContain("my app: ");

    // The real proof: bash parses it. `-n` checks syntax without executing.
    const script = join(dir, "accept.sh");

    await writeFile(script, `${accept}\n`);

    const parse = await runShellCommand(
      dir,
      `bash -n ${JSON.stringify(script)}`
    );

    expect(parse.exitCode).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unpackagedCodePaths: code outside every package, docs excluded", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "app"));
    await mkdir(join(dir, "stray"));
    await writeFile(join(dir, "app", "package.json"), "{}");

    expect(unpackagedCodePaths(dir, ["app/src/x.ts", "README.md"])).toEqual([]);
    expect(
      unpackagedCodePaths(dir, ["stray/x.ts", "note.md", "top.tsx"])
    ).toEqual(["stray/x.ts", "top.tsx"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkspaceContainerGate: ungated code fails instead of passing vacuously", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "app"));
    await mkdir(join(dir, "stray"));
    await writeFile(join(dir, "app", "package.json"), "{}");
    await writeFile(join(dir, "stray", "x.ts"), "export const x = 1;\n");

    const { result } = await runWorkspaceContainerGate(
      dir,
      stubTask,
      ["stray/x.ts"],
      undefined,
      {}
    );

    expect(result.passed).toBe(false);
    expect(result.errors.map((e) => e.file)).toEqual(["stray/x.ts"]);
    expect(result.output).toContain("stray/x.ts");
    expect(result.output).not.toContain("gate skipped");

    // Same verdict when a real package was gated in the same cycle: a green
    // package must not absorb code nothing can gate.
    const mixed = await runWorkspaceContainerGate(
      dir,
      stubTask,
      ["app/src/x.ts", "stray/x.ts"],
      undefined,
      {}
    );

    expect(mixed.result.passed).toBe(false);
    expect(mixed.result.errors.some((e) => e.file === "stray/x.ts")).toBe(true);
    expect(mixed.result.output).toContain("── app ──");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("owningPackageRoot: nested file maps to its package, outside maps to null", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "app", "package.json"), "{}");

    expect(
      owningPackageRoot(dir, join(dir, "app", "src", "deep", "x.ts"))
    ).toBe(join(dir, "app"));
    expect(owningPackageRoot(dir, join(dir, "notes", "x.ts"))).toBe(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeWorkspaceFileLinter: files under no package report clean", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "app", "package.json"), "{}");

    const lint = makeWorkspaceFileLinter(dir);

    expect(await lint(join(dir, "notes", "x.ts"))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
