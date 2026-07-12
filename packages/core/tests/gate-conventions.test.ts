import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { makeFileLinter } from "../src/gate";
import { resolveConventions } from "../src/infer-rules/conventions";

// Integration test for the REAL gate path: spawn the bundled eslint config the
// way buildGate/buildWebGate do, with TSFORGE_CONVENTIONS in the env, and assert
// which rules fire. This proves the env channel — not just the in-process builder.
const ROOT = join(import.meta.dir, "..", "..", "..");
const ESLINT_BIN = join(ROOT, "node_modules", ".bin", "eslint");
const STRICT_CONFIG = join(import.meta.dir, "..", "strict.eslint.config.mjs");

const BARE_INTERFACE = "export interface User {\n  id: string;\n}\n";
const ENUM_DECL = "export enum Color {\n  Red,\n  Blue,\n}\n";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tsforge-gate-conv-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface ILintMessage {
  ruleId: string | null;
  severity: number;
}

interface ILintResult {
  messages: ILintMessage[];
}

function isLintResults(value: unknown): value is ILintResult[] {
  return Array.isArray(value);
}

/** Run the bundled config on `content` with a TSFORGE_CONVENTIONS env, returning
 *  the set of rule IDs that errored. */
async function erroredRules(
  config: string,
  content: string,
  conventions?: string
): Promise<Set<string>> {
  const file = join(
    dir,
    `case-${Math.abs(hashOf(content + (conventions ?? "")))}.ts`
  );

  writeFileSync(file, content);

  const env: Record<string, string | undefined> = { ...process.env };

  if (conventions !== undefined) {
    env.TSFORGE_CONVENTIONS = conventions;
  }

  const proc = Bun.spawn(
    [
      "bun",
      ESLINT_BIN,
      "--no-config-lookup",
      "-c",
      config,
      "--format",
      "json",
      basename(file),
    ],
    { cwd: dir, env, stdout: "pipe", stderr: "pipe" }
  );

  const out = await new Response(proc.stdout).text();

  await proc.exited;

  const parsed: unknown = JSON.parse(out);
  const results = isLintResults(parsed) ? parsed : [];
  const ruleIds = new Set<string>();

  for (const r of results) {
    for (const m of r.messages) {
      if (m.severity === 2 && m.ruleId !== null) {
        ruleIds.add(m.ruleId);
      }
    }
  }

  return ruleIds;
}

/** Deterministic small hash so concurrent cases write distinct files. */
function hashOf(s: string): number {
  let h = 0;

  for (const ch of s) {
    h = (h * 31 + ch.charCodeAt(0)) | 0;
  }

  return h;
}

const NAMING = "@typescript-eslint/naming-convention";
const NRS = "no-restricted-syntax";

describe("core gate honors TSFORGE_CONVENTIONS", () => {
  test("default: bare interface fails naming, enum is banned", async () => {
    expect(await erroredRules(STRICT_CONFIG, BARE_INTERFACE)).toContain(NAMING);
    expect(await erroredRules(STRICT_CONFIG, ENUM_DECL)).toContain(NRS);
  });

  test("bare-pascal-case: bare interface passes", async () => {
    const errs = await erroredRules(
      STRICT_CONFIG,
      BARE_INTERFACE,
      '{"interfaces":"bare-pascal-case"}'
    );

    expect(errs).not.toContain(NAMING);
  });

  test("enums allow: enum passes on core", async () => {
    const errs = await erroredRules(
      STRICT_CONFIG,
      ENUM_DECL,
      '{"enums":"allow"}'
    );

    expect(errs).not.toContain(NRS);
  });
});

describe("write-time linter honors conventions (overrideConfig path)", () => {
  test("default flags a bare interface; bare-pascal-case does not", async () => {
    const f = join(dir, "wl.ts");

    writeFileSync(f, BARE_INTERFACE);

    const def = await makeFileLinter("core", f.replace(/[^/]+$/u, ""))(f);
    const bare = await makeFileLinter(
      "core",
      f.replace(/[^/]+$/u, ""),
      undefined,
      undefined,
      resolveConventions({ interfaces: "bare-pascal-case" })
    )(f);

    expect(def.some((m) => m.ruleId === NAMING)).toBe(true);
    expect(bare.some((m) => m.ruleId === NAMING)).toBe(false);
  });
});
