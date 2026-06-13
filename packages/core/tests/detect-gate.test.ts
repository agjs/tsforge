import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGate,
  buildWebGate,
  makeFileLinter,
  scaffoldWeb,
} from "../src/detect-gate";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tsforge-gate-"));
}

test("greenfield TS project: brings a strict tsconfig + gates on tsc AND eslint", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const gate = await buildGate(dir);

    // type-aware floor + syntactic idioms
    expect(gate.command).toContain("--noEmit -p tsconfig.json");
    expect(gate.command).toContain("strict.eslint.config.mjs");
    expect(gate.label).toContain("tsc --strict");
    expect(gate.label).toContain("strict TypeScript");

    // it brought a strict tsconfig with the index-safety floor
    const tsconfig = await readFile(join(dir, "tsconfig.json"), "utf8");

    expect(tsconfig).toContain("noUncheckedIndexedAccess");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("always uses tsforge strict eslint, ignoring the project's lint script", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } })
    );
    const gate = await buildGate(dir);

    // Policy: never defer to the project's lint script (that's how a weak repo
    // would dodge the strict-TS floor). Always the bundled strict config.
    expect(gate.command).not.toContain("run lint");
    expect(gate.command).toContain("strict.eslint.config.mjs");
    expect(gate.label).toContain("strict TypeScript");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing tsconfig: not overwritten, but gated via a strict override that extends it", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await writeFile(join(dir, "tsconfig.json"), '{ "mine": true }\n');
    const gate = await buildGate(dir);

    // The project's own tsconfig is never clobbered…
    expect(await readFile(join(dir, "tsconfig.json"), "utf8")).toContain(
      '"mine": true'
    );

    // …but the gate runs a strict overlay that extends it and forces the floor.
    // The overlay lives under .tsforge/ (not a sibling in the project root).
    expect(gate.command).toContain("-p .tsforge/tsconfig.gate.json");
    expect(existsSync(join(dir, "tsforge.tsconfig.json"))).toBe(false);
    const override = await readFile(
      join(dir, ".tsforge", "tsconfig.gate.json"),
      "utf8"
    );

    expect(override).toContain('"extends": "../tsconfig.json"');
    expect(override).toContain("noUncheckedIndexedAccess");

    // The ephemeral overlay is self-ignored so it never lands in the user's git.
    expect(
      await readFile(join(dir, ".tsforge", ".gitignore"), "utf8")
    ).toContain("tsconfig.gate.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-TS directory (no package.json): eslint-only, no tsc, no tsconfig written", async () => {
  const dir = await tempDir();

  try {
    const gate = await buildGate(dir);

    expect(gate.command).toContain("strict.eslint.config.mjs");
    expect(gate.command).not.toContain("--noEmit");
    expect(await Bun.file(join(dir, "tsconfig.json")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scaffoldWeb(react) lays the full kit; gate builds with Vite + browser", async () => {
  const dir = await tempDir();

  try {
    await scaffoldWeb(dir, "react");

    // A real modern project — shadcn/ui + TanStack + Tailwind, not a CDN page.
    expect(await Bun.file(join(dir, "index.html")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "vite.config.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "components.json")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "src/main.tsx")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "src/lib/utils.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "src/lib/sort.ts")).exists()).toBe(true); // typed sortBy
    expect(
      await Bun.file(join(dir, "src/components/ui/button.tsx")).exists()
    ).toBe(true);
    expect(await Bun.file(join(dir, "src/routes/__root.tsx")).exists()).toBe(
      true
    );

    const pkg = await readFile(join(dir, "package.json"), "utf8");

    expect(pkg).toContain("@tanstack/react-router");
    expect(pkg).toContain("@tanstack/react-query");
    expect(pkg).toContain("tailwind-merge");

    const html = await readFile(join(dir, "index.html"), "utf8");

    expect(html).toContain('id="root"');
    expect(html).toContain("/src/main.tsx");

    const gate = buildWebGate("react");

    expect(gate.command).toContain("bun run build"); // vite build FIRST (codegen)
    expect(gate.command).toContain("--noEmit"); // tsc
    expect(gate.command).toContain("strict.web.eslint.config.mjs"); // web eslint
    expect(gate.command).toContain("src/components/ui/**"); // vendored exempt
    expect(gate.command).toContain("*.gen.ts"); // generated exempt
    expect(gate.command).toContain("dist/index.html"); // render the BUILT app
    expect(gate.label).toContain("Vite");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scaffoldWeb(vanilla) lays a Vite + TS skeleton; gate has no vendored exempts", async () => {
  const dir = await tempDir();

  try {
    await scaffoldWeb(dir, "vanilla");

    expect(await Bun.file(join(dir, "src/main.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "src/style.css")).exists()).toBe(true);
    expect(
      await Bun.file(join(dir, "src/components/ui/button.tsx")).exists()
    ).toBe(false);

    const pkg = await readFile(join(dir, "package.json"), "utf8");

    expect(pkg).not.toContain("react");

    const gate = buildWebGate("vanilla");

    expect(gate.command).toContain("bun run build");
    expect(gate.command).toContain("dist/index.html");
    expect(gate.command).not.toContain("--ignore-pattern");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeFileLinter flags the moat rules tsc is blind to (the `as` cast), clean = []", async () => {
  const dir = await tempDir();

  try {
    const lint = makeFileLinter("react", dir);

    await mkdir(join(dir, "src"), { recursive: true });

    // The exact pattern a run log showed piling up unseen: type-valid (tsc passes),
    // but banned by the strict config's no-restricted-syntax `as` rule.
    const bad = join(dir, "src/foo.constants.ts");

    await writeFile(
      bad,
      "const x = Object.keys({ a: 1 }) as unknown as readonly string[];\n" +
        "export const y = x;\n"
    );

    const problems = await lint(bad);

    expect(problems.some((p) => p.ruleId === "no-restricted-syntax")).toBe(
      true
    );
    expect(problems.every((p) => typeof p.line === "number")).toBe(true);

    // A clean file yields no problems.
    const good = join(dir, "src/clean.ts");

    await writeFile(good, "export const n = 1;\n");
    expect(await lint(good)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("makeFileLinter does NOT report AUTO-FIXABLE issues (the janitor handles those)", async () => {
  const dir = await tempDir();

  try {
    const lint = makeFileLinter("react", dir);

    await mkdir(join(dir, "src"), { recursive: true });

    // Missing blank line before `return` → padding-line (AUTO-FIXABLE). The model
    // must never be nagged about it (the gate's eslint --fix/prettier squash it);
    // nagging caused an oscillation thrash in a run log. The non-fixable `as` cast
    // in the SAME file must still surface.
    const f = join(dir, "src/mix.ts");

    await writeFile(
      f,
      "export function f(): string {\n" +
        "  const v = (1 as unknown) as string;\n" +
        "  return v;\n" +
        "}\n"
    );

    const problems = await lint(f);

    expect(problems.some((p) => p.ruleId === "no-restricted-syntax")).toBe(
      true
    );
    expect(
      problems.some(
        (p) => p.ruleId === "@stylistic/padding-line-between-statements"
      )
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scaffoldWeb never overwrites an existing file", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "index.html"), "MINE\n");
    await scaffoldWeb(dir, "react");

    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("MINE\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
