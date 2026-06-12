import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doAddDependency,
  parsePackageSpecs,
} from "../src/loop/tools/add-dependency";
import type { IToolContext } from "../src/loop/tools/tool-context";

function ctx(cwd: string): IToolContext {
  return { cwd, files: ["**/*"], task: "t", report: () => undefined };
}

test("parsePackageSpecs accepts plain, scoped, and versioned names", () => {
  expect(parsePackageSpecs("date-fns")).toEqual(["date-fns"]);
  expect(parsePackageSpecs("zod@3 @tanstack/react-query")).toEqual([
    "zod@3",
    "@tanstack/react-query",
  ]);
  expect(parsePackageSpecs("react@^19.0.0")).toEqual(["react@^19.0.0"]);
});

test("parsePackageSpecs rejects flags, paths, and shell syntax", () => {
  expect(parsePackageSpecs("--registry http://evil")).toBeNull();
  expect(parsePackageSpecs("lodash; rm -rf /")).toBeNull();
  expect(parsePackageSpecs("../somewhere")).toBeNull();
  expect(parsePackageSpecs("a&&b")).toBeNull();
  expect(parsePackageSpecs("$(curl x)")).toBeNull();
  expect(parsePackageSpecs("")).toBeNull();
});

test("doAddDependency rejects bad specs and missing package.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-adddep-"));

  try {
    const bad = await doAddDependency({ packages: "-g evil" }, ctx(dir));

    expect(bad).toContain("plain npm package names");

    const noProject = await doAddDependency({ packages: "zod" }, ctx(dir));

    expect(noProject).toContain("no package.json");

    // With a package.json present, validation passes through to the install
    // (not executed here — covered by the live interactive eval).
    await writeFile(join(dir, "package.json"), "{}");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
