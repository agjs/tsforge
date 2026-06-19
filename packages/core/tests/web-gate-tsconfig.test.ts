import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWebGate } from "../src/detect-gate";

// Issue: a `bun:test` import in a scaffolded web app reds the gate with TS2307
// ("Cannot find module 'bun:test'"). Root cause: the web gate ran `tsc -p
// tsconfig.json` against the MODEL-EDITABLE project config; once that file lost its
// `**/*.test.ts` exclude (shadcn init / a model rewrite), tsc pulled the test files
// in and `bun:test` (a Bun runtime module tsc can't resolve without @types/bun) made
// the gate fail on EVERY build. Fix: typecheck through a harness-owned overlay that
// FORCES the exclude. This reproduces the worst case (clobbered tsconfig + a bun:test
// sibling + no @types/bun) and asserts the gate's tsc stays GREEN.
test("web gate tsc stays green on a bun:test sibling even when tsconfig.json drops the test exclude", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-webgate-"));

  try {
    // CLOBBERED project tsconfig — no `**/*.test.ts` exclude, no @types/bun.
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["**/*.ts"],
        exclude: ["node_modules"],
      })
    );
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src/impl.ts"),
      "export const add = (a: number, b: number): number => a + b;\n"
    );
    // A co-located bun:test sibling: would TS2307 if tsc pulled it into the program.
    await writeFile(
      join(dir, "src/impl.test.ts"),
      'import { test, expect } from "bun:test";\n' +
        'import { add } from "./impl";\n' +
        'test("add", () => {\n  expect(add(1, 2)).toBe(3);\n});\n'
    );

    // Building the web gate writes the harness-owned overlay into dir/.tsforge.
    const gate = buildWebGate("react", undefined, dir);

    expect(gate.command).toContain(".tsforge/tsconfig.web-gate.json");
    expect(gate.command).not.toContain("-p tsconfig.json");

    // Run JUST the overlay typecheck (the real gate also builds/lints, which needs
    // installed deps). Exit 0 == the test file was excluded; bun:test never loaded.
    const tscBin = join(process.cwd(), "node_modules/.bin/tsc");
    const proc = Bun.spawn(
      [tscBin, "--noEmit", "-p", ".tsforge/tsconfig.web-gate.json"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" }
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(output).not.toContain("bun:test");
    expect(exitCode).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
