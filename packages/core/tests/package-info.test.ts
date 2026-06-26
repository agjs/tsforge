import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doPackageDocs,
  doPackageInfo,
  packageNameFromSpec,
  type IPackageInfoDeps,
} from "../src/loop/tools/package-info";
import type { IToolContext } from "../src/loop/tools/tool-context";

const MANIFEST = {
  name: "zod",
  description: "schema validation",
  "dist-tags": { latest: "4.2.0", next: "4.3.0-beta.1" },
  versions: {
    "4.1.0": {
      version: "4.1.0",
      license: "MIT",
    },
    "4.2.0": {
      version: "4.2.0",
      license: "MIT",
      peerDependencies: { typescript: ">=5" },
      homepage: "https://zod.dev",
    },
  },
  repository: { url: "git+https://github.com/colinhacks/zod.git" },
  readme: "# Zod\n\nCurrent docs.",
};

function ctx(cwd = "."): IToolContext {
  return { cwd, files: [], task: "t", report: () => undefined };
}

function deps(json: unknown, requested: string[] = []): IPackageInfoDeps {
  return {
    fetchFn: async (url) => {
      requested.push(url);

      return {
        ok: true,
        status: 200,
        json: async () => json,
      };
    },
  };
}

test("packageNameFromSpec accepts scoped/unscoped optional versions", () => {
  expect(packageNameFromSpec("zod")).toBe("zod");
  expect(packageNameFromSpec("zod@4")).toBe("zod");
  expect(packageNameFromSpec("@tanstack/react-query")).toBe(
    "@tanstack/react-query"
  );
  expect(packageNameFromSpec("@tanstack/react-query@5")).toBe(
    "@tanstack/react-query"
  );
  expect(packageNameFromSpec("--flag")).toBeNull();
});

test("doPackageInfo fetches npm metadata and formats latest package details", async () => {
  const requested: string[] = [];
  const out = await doPackageInfo(
    { package: "zod", maxChars: 5000 },
    ctx(),
    deps(MANIFEST, requested)
  );

  expect(requested[0]).toContain("registry.npmjs.org/zod");
  expect(out).toContain("selected: 4.2.0");
  expect(out).toContain("latest: 4.2.0");
  expect(out).toContain("peerDependencies: typescript");
  expect(out).toContain("https://zod.dev");
});

test("doPackageInfo honors an explicit version in the package spec", async () => {
  const out = await doPackageInfo(
    { package: "zod@4.1.0" },
    ctx(),
    deps(MANIFEST)
  );

  expect(out).toContain("selected: 4.1.0");
});

test("doPackageDocs prefers local node_modules docs in auto mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-pkgdocs-"));

  try {
    const root = join(dir, "node_modules", "zod");

    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "zod", version: "4.2.0", types: "index.d.ts" })
    );
    await writeFile(join(root, "README.md"), "# Local Zod docs\n");
    await writeFile(
      join(root, "index.d.ts"),
      "export declare const z: string;\n"
    );

    const out = await doPackageDocs(
      { package: "zod" },
      ctx(dir),
      deps(MANIFEST)
    );

    expect(out).toContain("source=local");
    expect(out).toContain("Local Zod docs");
    expect(out).toContain("index.d.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doPackageDocs falls back to registry README when local docs are absent", async () => {
  const out = await doPackageDocs(
    { package: "zod", source: "registry" },
    ctx(),
    deps(MANIFEST)
  );

  expect(out).toContain("source=registry");
  expect(out).toContain("Current docs");
});

test("package tools reject invalid args without touching the network", async () => {
  let called = false;
  const noNetwork: IPackageInfoDeps = {
    fetchFn: async () => {
      called = true;

      throw new Error("should not be called");
    },
  };

  const info = await doPackageInfo({ package: "../x" }, ctx(), noNetwork);
  const docs = await doPackageDocs(
    { package: "zod", source: "somewhere" },
    ctx(),
    noNetwork
  );

  expect(called).toBe(false);
  expect(info).toContain("package_info");
  expect(docs).toContain("source");
});

test("recent versions and no-dist-tag latest sort by semver, not lexically", async () => {
  // Object key order is unspecified and a lexical sort misorders these
  // (1.10.0 < 1.9.0 as strings). With no dist-tags, latest must be the highest
  // semver, and "recent" must end on it.
  const manifest = {
    name: "pkg",
    versions: {
      "1.9.0": { version: "1.9.0" },
      "1.10.0": { version: "1.10.0" },
      "1.2.0": { version: "1.2.0" },
      "1.10.0-rc.1": { version: "1.10.0-rc.1" },
    },
  };

  const out = await doPackageInfo({ package: "pkg" }, ctx(), deps(manifest));

  // No dist-tags → fallback latest is the highest stable semver, not "1.9.0".
  expect(out).toContain("selected: 1.10.0");
  // Recent list is semver-ascending and the prerelease sorts below its release.
  expect(out).toContain("recent: 1.2.0, 1.9.0, 1.10.0-rc.1, 1.10.0");
});
