import { test, expect, beforeEach, afterEach } from "bun:test";
import { Glob } from "bun";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeImports,
  findEntryPoints,
  findMutualCycles,
  findSeams,
  mermaidBlocks,
  readSources,
  reservedNodeIds,
  resolveSpecifier,
  subsystemOf,
  validateRegistry,
  ROOT_ID,
} from "../src/architecture";
import type { IEdge } from "../src/architecture";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tsforge-arch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a file under the fixture src root, creating parent dirs. */
function put(rel: string, text: string): string {
  const path = join(root, rel);

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf-8");

  return path;
}

async function edgesOf(): Promise<IEdge[]> {
  const sources = await readSources(root);
  const { edges } = await analyzeImports(root, [...sources.keys()]);

  return edges;
}

test("a relative import lands in the imported subsystem, not the importer", async () => {
  put(
    "alpha/index.ts",
    'import { x } from "../beta/thing";\nexport const a = x;\n'
  );
  put("beta/thing.ts", "export const x = 1;\n");

  const edges = await edgesOf();

  expect(edges.map((e) => `${e.from}->${e.to}`)).toEqual(["alpha->beta"]);
});

test("a bare directory import resolves to that subsystem, not to (root)", async () => {
  // The regression that hid three subsystems: `../beta` resolves to the DIRECTORY
  // src/beta, whose relative path is a single segment. Bucketing by segment count
  // alone calls that a root file and silently drops the whole subsystem.
  put("alpha/index.ts", 'import { x } from "../beta";\nexport const a = x;\n');
  put("beta/index.ts", "export const x = 1;\n");

  const edges = await edgesOf();

  expect(edges.map((e) => e.to)).toEqual(["beta"]);
});

test("a file wins over a directory of the same name", async () => {
  // `src/cli.ts` and `src/cli/` both exist in the real tree, so resolution order is
  // load-bearing: getting it backwards reassigns every cli.ts import to the subsystem.
  put("cli.ts", "export const fromFile = true;\n");
  put("cli/index.ts", "export const fromDir = true;\n");
  const importer = put(
    "alpha/index.ts",
    'import { fromFile } from "../cli";\n'
  );

  expect(resolveSpecifier(importer, "../cli")).toBe(join(root, "cli.ts"));

  const edges = await edgesOf();

  expect(edges.map((e) => e.to)).toEqual([ROOT_ID]);
});

test("an import spelled inside a string constant is not an edge", async () => {
  // loop/boringstack/wire-resource.ts stores code it GENERATES in string constants.
  // A text scan reads those as this file's own imports and invents subsystems.
  put(
    "alpha/index.ts",
    "const TEMPLATE = '} from \"../ghost/schema\";';\nexport const a = TEMPLATE;\n"
  );
  put("ghost/schema.ts", "export const g = 1;\n");

  const edges = await edgesOf();

  expect(edges).toHaveLength(0);
});

test("a type-only import still counts as coupling", async () => {
  put(
    "alpha/index.ts",
    'import type { T } from "../beta/types";\nexport type A = T;\n'
  );
  put("beta/types.ts", "export type T = string;\n");

  const edges = await edgesOf();

  expect(edges.map((e) => `${e.from}->${e.to}`)).toEqual(["alpha->beta"]);
});

test("an edge carries the file and line that prove it", async () => {
  put(
    "alpha/index.ts",
    '// leading comment\nimport { x } from "../beta/thing";\n'
  );
  put("beta/thing.ts", "export const x = 1;\n");

  const edges = await edgesOf();

  expect(edges.map((e) => e.witness)).toEqual([
    join("alpha", "index.ts") + ":2",
  ]);
  expect(edges.map((e) => e.specifier)).toEqual(["../beta/thing"]);
});

test("an import leaving src is reported as external, not as an edge", async () => {
  mkdirSync(join(root, "..", "outside"), { recursive: true });
  const outside = join(root, "..", "outside", "helper.ts");

  writeFileSync(outside, "export const h = 1;\n", "utf-8");
  put(
    "alpha/index.ts",
    'import { h } from "../../outside/helper";\nexport const a = h;\n'
  );

  const sources = await readSources(root);
  const { edges, externals } = await analyzeImports(root, [...sources.keys()]);

  expect(edges).toHaveLength(0);
  expect(externals.map((e) => e.from)).toEqual(["alpha"]);

  rmSync(join(root, "..", "outside"), { recursive: true, force: true });
});

test("a file directly in src belongs to the root bucket", () => {
  expect(subsystemOf(root, join(root, "cli.ts"))).toBe(ROOT_ID);
  expect(subsystemOf(root, join(root, "loop", "run.ts"))).toBe("loop");
  expect(subsystemOf(root, join(root, "..", "elsewhere.ts"))).toBeNull();
});

test("mutual imports are reported once, with both directions", async () => {
  put(
    "alpha/index.ts",
    'import type { B } from "../beta/types";\nexport type A = B;\n'
  );
  put(
    "beta/types.ts",
    'import type { C } from "../alpha/other";\nexport type B = C;\n'
  );
  put("alpha/other.ts", "export type C = string;\n");

  const cycles = findMutualCycles(await edgesOf());

  expect(cycles.map((c) => `${c.a}<->${c.b}`)).toEqual(["alpha<->beta"]);
  expect(cycles.map((c) => c.aToB.witness)).toEqual([
    join("alpha", "index.ts") + ":1",
  ]);
  expect(cycles.map((c) => c.bToA.witness)).toEqual([
    join("beta", "types.ts") + ":1",
  ]);
});

test("the witness for an edge does not depend on file order", async () => {
  // An edge keeps the FIRST file that produces it. Glob.scan yields filesystem order,
  // so without a sort the same commit generates a different map on a Mac than in CI
  // and the drift check fails on a file nobody touched. It did.
  put(
    "alpha/a-first.ts",
    'import { x } from "../beta/thing";\nexport const a = x;\n'
  );
  put(
    "alpha/z-last.ts",
    'import { x } from "../beta/thing";\nexport const z = x;\n'
  );
  put("beta/thing.ts", "export const x = 1;\n");

  const sources = await readSources(root);
  const paths = [...sources.keys()];

  const forward = await analyzeImports(root, paths);
  const reversed = await analyzeImports(root, [...paths].reverse());

  expect(forward.edges.map((e) => e.witness)).toEqual([
    join("alpha", "a-first.ts") + ":1",
  ]);
  expect(reversed.edges.map((e) => e.witness)).toEqual(
    forward.edges.map((e) => e.witness)
  );
});

test("readSources yields files in sorted order", async () => {
  put("zulu/z.ts", "export const z = 1;\n");
  put("alpha/a.ts", "export const a = 1;\n");
  put("mike/m.ts", "export const m = 1;\n");

  const keys = [...(await readSources(root)).keys()];

  expect(keys).toEqual([...keys].sort());
});

test("a one-way import is not a cycle", async () => {
  put(
    "alpha/index.ts",
    'import { x } from "../beta/thing";\nexport const a = x;\n'
  );
  put("beta/thing.ts", "export const x = 1;\n");

  expect(findMutualCycles(await edgesOf())).toHaveLength(0);
});

test("registry drift fails when a subsystem has no entry", () => {
  expect(() => validateRegistry(["loop", "brand-new-thing"])).toThrow(
    /brand-new-thing/
  );
});

test("registry drift fails when an entry names a subsystem that is gone", () => {
  expect(() => validateRegistry(["loop"])).toThrow(/gate/);
});

test("the real subsystem list satisfies the registry", async () => {
  // Guards the generator against the repo growing a directory nobody described.
  const sources = await readSources(join(import.meta.dir, "..", "src"));
  const ids = new Set<string>();

  for (const path of sources.keys()) {
    const id = subsystemOf(join(import.meta.dir, "..", "src"), path);

    if (id !== null) {
      ids.add(id);
    }
  }

  expect(() => validateRegistry([...ids])).not.toThrow();
});

test("a CLI command is found by its signature, not its name", async () => {
  put(
    "cli.ts",
    [
      "export async function reviewMode(a: number): Promise<number> { return a; }",
      "export function isPolicyMode(v: string): boolean { return v === 'x'; }",
      "export async function loadThing(): Promise<string> { return 'x'; }",
    ].join("\n")
  );

  const entries = findEntryPoints(root, await readSources(root));

  expect(entries.map((e) => e.fn)).toEqual(["reviewMode"]);
});

test("a command in the cli subtree is found, not just cli.ts", async () => {
  // harnessReviewMode lives in cli/harness-review-mode.ts — narrowing the scan to
  // cli.ts alone drops real commands without failing anything else.
  put(
    "cli/harness-review-mode.ts",
    "export async function harnessReviewMode(): Promise<number> { return 0; }"
  );

  const entries = findEntryPoints(root, await readSources(root));

  expect(entries.map((e) => e.fn)).toEqual(["harnessReviewMode"]);
});

test("a command outside the cli tree is not an entry point", async () => {
  put(
    "loop/run.ts",
    "export async function runMode(): Promise<number> { return 0; }"
  );

  expect(findEntryPoints(root, await readSources(root))).toHaveLength(0);
});

test("a seam reports where it is declared", async () => {
  put(
    "gate/gate-runner.ts",
    "// header\nexport interface IGate { run(): void }\n"
  );
  put(
    "loop/planning/stack-adapter.ts",
    "export interface IStackAdapter { id: string }\n"
  );
  put(
    "loop/conventions-provider.ts",
    "export interface IConventionProvider { g(): string }\n"
  );
  put(
    "loop/planning/plan-types.ts",
    "export interface IPlanSchema<T> { t: T }\nexport interface IProductPlan<T> { t: T }\n"
  );
  put(
    "loop/boringstack/planning.ts",
    'import type { IStackAdapter } from "../planning/stack-adapter";\nexport const a: IStackAdapter = { id: "b" };\n'
  );

  const seams = findSeams(root, await readSources(root));
  const gate = seams.find((s) => s.name === "IGate");
  const adapter = seams.find((s) => s.name === "IStackAdapter");

  expect(gate?.declaredAt).toBe(join("gate", "gate-runner.ts") + ":2");
  expect(adapter?.implementors).toContain(
    join("loop", "boringstack", "planning.ts")
  );
});

test("a reserved node id is reported, in declarations and in edges", () => {
  // The exact bug this guards: `call --> resp` fails with "got 'CALLBACKNAME'".
  expect(reservedNodeIds('call["model call"]\ncall --> resp')).toEqual([
    "call",
  ]);
  expect(reservedNodeIds("a --> end")).toEqual(["end"]);
  expect(reservedNodeIds('modelCall["fine"]\nmodelCall --> resp')).toEqual([]);
});

test("every mermaid diagram in the docs avoids reserved node ids", async () => {
  // Mermaid parses in the browser, so a bad id renders as a blank gap while
  // `astro build` still succeeds. Nothing else in CI looks at these blocks.
  const docsDir = join(import.meta.dir, "..", "..", "..", "apps", "docs");
  const pages = new Glob("src/content/docs/**/*.{md,mdx}");
  const offenders: string[] = [];

  for await (const rel of pages.scan(docsDir)) {
    const text = await Bun.file(join(docsDir, rel)).text();

    for (const block of mermaidBlocks(text)) {
      for (const id of reservedNodeIds(block)) {
        offenders.push(`${rel}: ${id}`);
      }
    }
  }

  expect(offenders).toEqual([]);
});

test("a seam that loses its declaration fails the build", async () => {
  put("gate/gate-runner.ts", "export interface IGate { run(): void }\n");

  await expect(
    (async () => findSeams(root, await readSources(root)))()
  ).rejects.toThrow(/IStackAdapter/);
});
