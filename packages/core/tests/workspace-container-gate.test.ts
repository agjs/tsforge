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
  relocatePackageError,
  capturePackageGatePolicy,
  resolvePackageGate,
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

test("isWorkspaceContainer: root package.json WITH deps is never a container", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      '{"dependencies":{"left-pad":"1.0.0"}}'
    );
    await mkdir(join(dir, "packages"));
    await writeFile(join(dir, "packages", "package.json"), "{}");

    expect(isWorkspaceContainer(dir)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isWorkspaceContainer: scripts-only shell root over nested packages IS a container (boringstack shape)", async () => {
  const dir = await tempDir();

  try {
    // Root manifest: scripts/engines only — no dependency fields at all.
    await writeFile(
      join(dir, "package.json"),
      '{"name":"mono","private":true,"scripts":{"check":"true"},"engines":{"bun":"1.3.14"}}'
    );
    // Packages at depth 2 under a grouping dir, like apps/api + apps/ui.
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await mkdir(join(dir, "apps", "ui"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "package.json"), '{"name":"api"}');
    await writeFile(join(dir, "apps", "ui", "package.json"), '{"name":"ui"}');

    expect(isWorkspaceContainer(dir)).toBe(true);
    expect(listChildPackageRoots(dir)).toEqual([
      join(dir, "apps", "api"),
      join(dir, "apps", "ui"),
    ]);
    // A tsconfig littered at the root by an old greenfield write must not
    // change the verdict — detection keys on the manifest, not the litter.
    await writeFile(join(dir, "tsconfig.json"), "{}");
    expect(isWorkspaceContainer(dir)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isWorkspaceContainer: empty dep OBJECTS still count as a shell; bad JSON fails closed", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "api"));
    await writeFile(join(dir, "api", "package.json"), '{"name":"api"}');

    await writeFile(
      join(dir, "package.json"),
      '{"name":"mono","dependencies":{},"devDependencies":{}}'
    );
    expect(isWorkspaceContainer(dir)).toBe(true);

    // Unparseable root manifest → treat as a real package (never re-scope the
    // gate on bad JSON).
    await writeFile(join(dir, "package.json"), "{not json");
    expect(isWorkspaceContainer(dir)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listChildPackageRoots: never descends INTO a package (nested fixtures stay its own)", async () => {
  const dir = await tempDir();

  try {
    await mkdir(join(dir, "api", "examples", "demo"), { recursive: true });
    await writeFile(join(dir, "api", "package.json"), '{"name":"api"}');
    await writeFile(
      join(dir, "api", "examples", "demo", "package.json"),
      '{"name":"demo"}'
    );

    expect(listChildPackageRoots(dir)).toEqual([join(dir, "api")]);
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

test("relocatePackageError: identical relative paths stay distinct across packages", () => {
  const a = relocatePackageError("app", "/ws/app", {
    key: "src/bad.ts:no-as",
    file: "src/bad.ts",
    message: "no as",
  });
  const b = relocatePackageError("api", "/ws/api", {
    key: "src/bad.ts:no-as",
    file: "src/bad.ts",
    message: "no as",
  });

  expect(a.file).toBe("app/src/bad.ts");
  expect(b.file).toBe("api/src/bad.ts");
  expect(a.key).not.toBe(b.key);
  expect(new Set([a.key, b.key]).size).toBe(2);
});

test("relocatePackageError: absolute ESLint paths become package-relative under the label", () => {
  const pkgDir = "/tmp/ws/app";
  const relocated = relocatePackageError("app", pkgDir, {
    key: `${pkgDir}/src/bad.ts:no-as`,
    file: `${pkgDir}/src/bad.ts`,
    message: "no as",
  });

  expect(relocated.file).toBe("app/src/bad.ts");
  expect(relocated.key).toContain("app/src/bad.ts");
  expect(relocated.key).not.toContain("/tmp/ws");
});

test("resolvePackageGate: external pack ids stay out of the subprocess pack list", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "pkg" }));
    // A fake absolute plugin path that won't load — capture should still
    // keep builtins-only activePacks even when plugins are declared.
    await writeFile(
      join(dir, "tsforge.config.json"),
      JSON.stringify({
        packs: { include: ["generic-ts"] },
      })
    );

    const policy = await capturePackageGatePolicy(dir);
    const resolved = await resolvePackageGate(policy);

    // Gate command packs = builtins; lint packs may equal that when no plugins.
    expect(policy.activePacks.has("generic-ts")).toBe(true);
    expect(policy.externalPackIds).toEqual([]);
    expect(resolved.packs).toContain("generic-ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capturePackageGatePolicy: freezes config so mid-session exclude cannot drop newly detected packs", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "pkg", dependencies: {} })
    );

    const policy = await capturePackageGatePolicy(dir);

    expect(policy.activePacks.has("react")).toBe(false);

    // Mid-session: model adds react AND someone excludes it in config.
    // Frozen policy must still pick up the stack pack (gate-setup contract).
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "pkg",
        dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
      })
    );
    await writeFile(
      join(dir, "tsforge.config.json"),
      JSON.stringify({
        packs: { exclude: ["react", "react-component-architecture"] },
      })
    );

    const resolved = await resolvePackageGate(policy);

    expect(resolved.packs).toContain("react");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capturePackageGatePolicy: --profile strict and --strict-floor-only apply", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "pkg",
        scripts: { test: "echo ok" },
      })
    );

    const strict = await capturePackageGatePolicy(dir, { profile: "strict" });

    expect(strict.profile).toBe("strict");
    expect(strict.testCommand).not.toBeNull();

    const floorOnly = await capturePackageGatePolicy(dir, {
      strictFloorOnly: true,
    });

    expect(floorOnly.testCommand).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("capturePackageGatePolicy: child ruleOverrides stay package-local", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }));
    await writeFile(
      join(dir, "tsforge.config.json"),
      JSON.stringify({
        rules: { "no-undeclared-dependencies": "off" },
      })
    );

    const policy = await capturePackageGatePolicy(dir);

    expect(policy.ruleOverrides["no-undeclared-dependencies"]).toBe("off");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// FG-1 seam: a change written OUTSIDE the edit tools (empty `touched`) must
// still gate. Pre-fix, this exact scenario returned passed:true accept:"true"
// — the false green that motivated the git-baseline detection.
test("runWorkspaceContainerGate: extraPackageRoots gates a shell-written package despite empty touched", async () => {
  const dir = await tempDir();

  try {
    const api = join(dir, "api");

    await mkdir(join(api, "src"), { recursive: true });
    await writeFile(join(api, "package.json"), '{"name":"api"}');
    await writeFile(
      join(api, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true } })
    );
    // The type-broken file a `sed -i` would produce — invisible to `touched`.
    await writeFile(
      join(api, "src", "index.ts"),
      'export const n: number = "boom";\n'
    );

    const run = await runWorkspaceContainerGate(dir, stubTask, [], undefined, {
      extraPackageRoots: [api],
    });

    // Not the vacuous green skip: the package actually gated, red, with a
    // real executable accept and the detection notice in its section.
    expect(run.result.passed).toBe(false);
    expect(run.accept).not.toBe("true");
    expect(run.accept).toContain("api");
    expect(run.label).toBe("api");
    expect(run.result.output).toContain("included via git-detected changes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test("runWorkspaceContainerGate: detected roots UNION with touched (both gate)", async () => {
  const dir = await tempDir();

  try {
    for (const name of ["api", "app"]) {
      const pkg = join(dir, name);

      await mkdir(join(pkg, "src"), { recursive: true });
      await writeFile(join(pkg, "package.json"), `{"name":"${name}"}`);
      await writeFile(
        join(pkg, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true } })
      );
      await writeFile(join(pkg, "src", "index.ts"), "export const n = 1;\n");
    }

    const run = await runWorkspaceContainerGate(
      dir,
      stubTask,
      ["app/src/index.ts"],
      undefined,
      { extraPackageRoots: [join(dir, "api")] }
    );

    expect(run.label).toBe("api + app");
    // Only the DETECTED package carries the notice; the touched one doesn't.
    expect(run.result.output).toContain(
      "── api ── (included via git-detected changes"
    );
    expect(run.result.output).not.toContain(
      "── app ── (included via git-detected changes"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 240_000);
