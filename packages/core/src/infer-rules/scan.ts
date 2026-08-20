import { join } from "node:path";
import { existsSync } from "node:fs";
import { Glob } from "bun";
import ts from "typescript";
import { detectStack } from "../stack-detection";
import { resolveConventions } from "./conventions";
import type {
  IFolderScan,
  IInterfaceScan,
  IScanReport,
  ITestScan,
  IToolingScan,
  IWizardDefaults,
} from "./scan.types";
import type { IConventions } from "./conventions.types";

/** Dirs never worth scanning (deps, build output, vcs, tsforge's own state). */
const IGNORE = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".tsforge",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".vite",
  "scratch",
]);
/** Bound the scan so a huge tree can't stall the wizard. */
const MAX_FILES = 800;
const MAX_BYTES = 262_144;
/** A name like `IUser`/`IButtonProps` (capital after the leading I), NOT `Issue`. */
const I_PREFIXED = /^I[A-Z]/u;
/** Library-mandated augmentation names we never count as a naming signal. */
const NAMING_EXEMPT = new Set(["Register"]);

interface IMutableInterfaceScan {
  iPrefixed: number;
  bare: number;
  total: number;
  iExamples: string[];
  bareExamples: string[];
}

function ignored(rel: string): boolean {
  return rel.split("/").some((seg) => IGNORE.has(seg));
}

/** Walk one source file, tallying interface naming + whether it declares an enum. */
function tallyFile(
  text: string,
  path: string,
  acc: IMutableInterfaceScan
): boolean {
  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false
  );
  let hasEnum = false;

  const visit = (node: ts.Node): void => {
    if (ts.isEnumDeclaration(node)) {
      hasEnum = true;
    } else if (ts.isInterfaceDeclaration(node)) {
      countInterface(node.name.text, acc);
    }

    node.forEachChild(visit);
  };

  sf.forEachChild(visit);

  return hasEnum;
}

function countInterface(name: string, acc: IMutableInterfaceScan): void {
  if (NAMING_EXEMPT.has(name)) {
    return;
  }

  acc.total += 1;

  if (I_PREFIXED.test(name)) {
    acc.iPrefixed += 1;

    if (acc.iExamples.length < 3) {
      acc.iExamples.push(name);
    }
  } else {
    acc.bare += 1;

    if (acc.bareExamples.length < 3) {
      acc.bareExamples.push(name);
    }
  }
}

/** Classify a test file by layout: under a `tests/` segment ⇒ mirrored, else
 *  co-located beside its source. */
function classifyTest(
  rel: string,
  tests: { co: number; mirror: number }
): void {
  if (rel.split("/").includes("tests")) {
    tests.mirror += 1;
  } else {
    tests.co += 1;
  }
}

const TEST_FILE = /\.(test|spec)\.tsx?$/u;

/** Read-only scan of the whole codebase, capped. Parses TS/TSX via the compiler's
 *  AST (no project, no execution of any repo config) and globs for layout signals. */
export async function scanRepo(cwd: string): Promise<IScanReport> {
  const stack = await detectStack(cwd);
  const iface: IMutableInterfaceScan = {
    iPrefixed: 0,
    bare: 0,
    total: 0,
    iExamples: [],
    bareExamples: [],
  };
  const tests = { co: 0, mirror: 0 };
  let enumFiles = 0;
  let filesScanned = 0;

  // Collect + SORT before sampling: `Glob.scan` yields in filesystem order,
  // which isn't stable across machines/runs, so at/above the MAX_FILES cap the
  // recommendation depended on WHICH files were seen (a large repo could infer
  // different rules run-to-run). A lexical sort makes the sampled set — and thus
  // the inferred conventions — deterministic.
  const all: string[] = [];

  for await (const rel of new Glob("**/*.{ts,tsx}").scan({
    cwd,
    onlyFiles: true,
  })) {
    all.push(rel);
  }

  all.sort();

  for (const rel of all) {
    if (ignored(rel)) {
      continue;
    }

    if (TEST_FILE.test(rel)) {
      classifyTest(rel, tests);
    }

    const file = Bun.file(join(cwd, rel));

    if (file.size > MAX_BYTES) {
      continue;
    }

    // Ambient declarations (`.d.ts`) are generated/third-party, not the repo's
    // AUTHORED convention — never let them decide a rule.
    if (rel.endsWith(".d.ts")) {
      continue;
    }

    try {
      const hasEnum = tallyFile(await file.text(), rel, iface);

      // A test-file enum (a fixture) is not the repo's source policy — a single
      // one must not flip the whole-repo enum ban off.
      if (hasEnum && !TEST_FILE.test(rel)) {
        enumFiles += 1;
      }
    } catch {
      // A file deleted/locked/permission-denied mid-scan must not crash the
      // wizard — skip it and keep scanning.
      continue;
    }

    filesScanned += 1;

    if (filesScanned >= MAX_FILES) {
      break;
    }
  }

  const interfaces: IInterfaceScan = { ...iface };

  return {
    stack,
    interfaces,
    enums: { fileCount: enumFiles },
    tests: { coLocated: tests.co, mirrored: tests.mirror },
    folders: scanFolders(cwd),
    tooling: scanTooling(cwd),
    filesScanned,
  };
}

function dirExists(cwd: string, rel: string): boolean {
  return existsSync(join(cwd, rel));
}

function scanFolders(cwd: string): IFolderScan {
  return {
    views: dirExists(cwd, "src/views"),
    features: dirExists(cwd, "src/features"),
    flatComponents: dirExists(cwd, "src/components"),
    routeFolders: dirExists(cwd, "src/routes") || dirExists(cwd, "app"),
  };
}

function anyExists(cwd: string, names: readonly string[]): boolean {
  return names.some((n) => existsSync(join(cwd, n)));
}

function scanTooling(cwd: string): IToolingScan {
  return {
    tsconfig: existsSync(join(cwd, "tsconfig.json")),
    eslint: anyExists(cwd, [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
    ]),
    prettier: anyExists(cwd, [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.js",
      ".prettierrc.cjs",
      "prettier.config.js",
      "prettier.config.mjs",
    ]),
  };
}

/** The dominant value when one side is clearly ahead (>= 60% and ahead of the
 *  other), else null (contested/empty → caller picks a neutral default). */
function dominant<T>(a: { v: T; n: number }, b: { v: T; n: number }): T | null {
  const total = a.n + b.n;

  if (total === 0) {
    return null;
  }

  if (a.n > b.n && a.n / total >= 0.6) {
    return a.v;
  }

  if (b.n > a.n && b.n / total >= 0.6) {
    return b.v;
  }

  return null;
}

/** Below this many interfaces there isn't enough evidence to infer a house
 *  convention — one or two examples would let a single file flip the whole
 *  repo's naming rule (or disable it). Fall back to the tsforge default. */
const MIN_INTERFACE_SAMPLE = 3;

function recommendInterfaces(scan: IInterfaceScan): IConventions["interfaces"] {
  if (scan.total < MIN_INTERFACE_SAMPLE) {
    // Too few to generalize (incl. greenfield total===0) → the house default,
    // never an inference from 1–2 files.
    return "i-prefix";
  }

  const winner = dominant<IConventions["interfaces"]>(
    { v: "i-prefix", n: scan.iPrefixed },
    { v: "bare-pascal-case", n: scan.bare }
  );

  // A genuinely split repo (enough evidence, but contested): don't impose a
  // contested naming rule.
  return winner ?? "off";
}

function recommendTests(scan: ITestScan): IConventions["tests"] {
  return (
    dominant<IConventions["tests"]>(
      { v: "co-located", n: scan.coLocated },
      { v: "mirrored", n: scan.mirrored }
    ) ?? "either"
  );
}

function recommendFolders(scan: IFolderScan): IConventions["componentFolders"] {
  if (scan.views) {
    return "tsforge-views";
  }

  if (scan.features || scan.flatComponents || scan.routeFolders) {
    return "repo";
  }

  return "tsforge-views"; // greenfield default
}

/** Map a scan to the RECOMMENDED conventions the wizard preselects. */
export function recommendConventions(report: IScanReport): IConventions {
  return resolveConventions({
    interfaces: recommendInterfaces(report.interfaces),
    enums: report.enums.fileCount > 0 ? "allow" : "ban",
    tests: recommendTests(report.tests),
    componentFolders: recommendFolders(report.folders),
  });
}

export function wizardDefaults(report: IScanReport): IWizardDefaults {
  return { conventions: recommendConventions(report) };
}
