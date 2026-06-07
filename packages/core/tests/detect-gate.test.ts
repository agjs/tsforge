import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGate, buildWebGate, scaffoldWeb } from "../src/detect-gate";

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

test("respects the project's own lint script (but still runs tsc)", async () => {
  const dir = await tempDir();

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } })
    );
    const gate = await buildGate(dir);

    expect(gate.command).toContain("run lint");
    expect(gate.label).toContain("project lint");
    expect(gate.command).toContain("--noEmit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("respects an existing tsconfig instead of overwriting it", async () => {
  const dir = await tempDir();

  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await writeFile(join(dir, "tsconfig.json"), '{ "mine": true }\n');
    await buildGate(dir);

    // untouched — we never clobber a project's own config
    expect(await readFile(join(dir, "tsconfig.json"), "utf8")).toContain(
      '"mine": true'
    );
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
