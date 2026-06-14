import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Proves the cognitive-complexity ceiling ships and fires through the REAL gate
// eslint invocation (i.e. eslint-plugin-sonarjs resolves from tsforge's own deps
// and the bundled strict config wires it). Runs the config the same way the gate
// command does.
const ROOT = join(import.meta.dir, "..", "..", "..");
const ESLINT_BIN = join(ROOT, "node_modules", ".bin", "eslint");
const STRICT_CONFIG = join(import.meta.dir, "..", "strict.eslint.config.mjs");

// A function whose cognitive complexity is well over 20 (nested loops + many
// branches) AND whose nesting depth exceeds 4.
const COMPLEX = `export function classify(items: readonly number[]): string {
  let out = "";

  for (const a of items) {
    if (a > 0) {
      for (const b of items) {
        if (b > a) {
          if (b % 2 === 0) {
            if (a % 2 === 0) {
              if (b > 100) {
                out = out + "x";
              } else if (b > 50) {
                out = out + "y";
              } else {
                out = out + "z";
              }
            }
          }
        }
      }
    } else if (a < 0) {
      if (a < -100) {
        out = out + "m";
      } else if (a < -50) {
        out = out + "n";
      } else {
        out = out + "o";
      }
    } else {
      out = out + "0";
    }
  }

  return out;
}
`;

const SIMPLE = `export function double(n: number): number {
  return n * 2;
}
`;

let fixtureDir: string;

beforeAll(() => {
  // realpathSync: macOS tmpdir() is a /var -> /private/var symlink; eslint 10
  // resolves cwd to the real path and would otherwise report the fixture file as
  // "outside of base path".
  fixtureDir = realpathSync(
    mkdtempSync(join(tmpdir(), "tsforge-gate-complexity-"))
  );
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  writeFileSync(join(fixtureDir, "src", "complex.ts"), COMPLEX);
  writeFileSync(join(fixtureDir, "src", "simple.ts"), SIMPLE);
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

interface ILintMessage {
  ruleId: string | null;
}
interface ILintedFile {
  messages: ILintMessage[];
}

function isLintedFileArray(value: unknown): value is ILintedFile[] {
  return Array.isArray(value);
}

async function ruleIdsFor(file: string): Promise<string[]> {
  const proc = Bun.spawn(
    [
      "bun",
      ESLINT_BIN,
      "--no-config-lookup",
      "-c",
      STRICT_CONFIG,
      "--format",
      "json",
      file,
    ],
    { cwd: fixtureDir, stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(proc.stdout).text();

  await proc.exited;

  const parsed: unknown = JSON.parse(stdout);

  if (!isLintedFileArray(parsed)) {
    throw new Error(`unexpected eslint output: ${stdout.slice(0, 200)}`);
  }

  return parsed.flatMap((f) => f.messages).map((m) => m.ruleId ?? "");
}

describe("gate complexity ceiling", () => {
  test("flags an over-complex, deeply-nested function", async () => {
    const ruleIds = await ruleIdsFor(join(fixtureDir, "src", "complex.ts"));

    expect(ruleIds).toContain("sonarjs/cognitive-complexity");
    expect(ruleIds).toContain("max-depth");
  });

  test("stays silent on a small, flat function", async () => {
    const ruleIds = await ruleIdsFor(join(fixtureDir, "src", "simple.ts"));

    expect(ruleIds).not.toContain("sonarjs/cognitive-complexity");
    expect(ruleIds).not.toContain("max-depth");
  });
});
