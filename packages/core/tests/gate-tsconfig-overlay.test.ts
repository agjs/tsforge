import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tscPart } from "../src/gate/tsconfig";
import { runShellCommand } from "../src/lib/fs";

/** Strict-family sub-flags the overlay must pin explicitly: `extends` merges
 *  compilerOptions per field and `strict` is only a DEFAULT for these, so a base
 *  config's explicit `"strictNullChecks": false` would beat the umbrella. */
const STRICT_SUB_FLAGS = [
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "alwaysStrict",
] as const;

describe("gate tsconfig overlay — the strict floor holds against a loose project config", () => {
  test("the written overlay enumerates every strict sub-flag explicitly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-overlay-"));

    try {
      await writeFile(join(dir, "tsconfig.json"), `{"compilerOptions":{}}`);
      await tscPart(dir);

      const overlay: unknown = JSON.parse(
        await readFile(join(dir, ".tsforge", "tsconfig.gate.json"), "utf8")
      );
      const options =
        typeof overlay === "object" &&
        overlay !== null &&
        "compilerOptions" in overlay
          ? overlay.compilerOptions
          : null;

      expect(options).not.toBeNull();

      for (const flag of STRICT_SUB_FLAGS) {
        expect(
          typeof options === "object" && options !== null && flag in options
            ? Reflect.get(options, flag)
            : undefined
        ).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("overlay defeats a project's explicit strictNullChecks:false (null into string reds)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-overlay-snc-"));

    try {
      // A loosely-configured (or model-loosened) project: strict off, and the
      // sub-flag EXPLICITLY false — the shape that beats a bare `strict: true`.
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: false,
            strictNullChecks: false,
            skipLibCheck: true,
            noEmit: true,
          },
        })
      );
      await writeFile(
        join(dir, "index.ts"),
        `const s: string = null;\nvoid s;\n`
      );

      const command = await tscPart(dir);

      expect(command).not.toBeNull();

      const run = await runShellCommand(dir, command ?? "", {
        timeoutMs: 120_000,
      });

      // Pre-fix (overlay only set the `strict` umbrella) this compiled CLEAN —
      // the gate claimed a strict floor it wasn't enforcing.
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout + run.stderr).toContain("TS2322");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("greenfield tsconfig — monorepo litter guard + Bun types", () => {
  test("no root tsconfig is written when child packages exist (monorepo root)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-litter-"));

    try {
      // boringstack shape: scripts-only root manifest, packages under apps/.
      await writeFile(
        join(dir, "package.json"),
        '{"name":"mono","private":true,"scripts":{"check":"true"}}'
      );
      await mkdir(join(dir, "apps", "api"), { recursive: true });
      await writeFile(
        join(dir, "apps", "api", "package.json"),
        '{"name":"api"}'
      );

      const command = await tscPart(dir);

      // Neither a gate command for the whole bag nor a littered tsconfig.json.
      expect(command).toBeNull();
      expect(existsSync(join(dir, "tsconfig.json"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("greenfield Bun package gets the installed Bun types in its tsconfig", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-buntypes-"));

    try {
      await writeFile(join(dir, "package.json"), '{"name":"svc"}');
      await writeFile(join(dir, "bun.lock"), "{}");
      await mkdir(join(dir, "node_modules", "@types", "bun"), {
        recursive: true,
      });
      await writeFile(
        join(dir, "node_modules", "@types", "bun", "package.json"),
        '{"name":"@types/bun"}'
      );

      await tscPart(dir);

      const written: unknown = JSON.parse(
        await readFile(join(dir, "tsconfig.json"), "utf8")
      );
      const types =
        typeof written === "object" &&
        written !== null &&
        "compilerOptions" in written
          ? Reflect.get(
              (written as { compilerOptions: object }).compilerOptions,
              "types"
            )
          : undefined;

      expect(types).toEqual(["@types/bun"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("greenfield non-Bun package gets NO types entry; Bun without installed types too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-notypes-"));

    try {
      await writeFile(join(dir, "package.json"), '{"name":"svc"}');
      await tscPart(dir);

      const plain = await readFile(join(dir, "tsconfig.json"), "utf8");

      expect(plain).not.toContain('"types"');
      expect(plain).not.toContain("__TYPES__");

      // Bun markers but no resolvable types package → still no entry (a types
      // line naming an absent package is a hard TS2688).
      await rm(join(dir, "tsconfig.json"));
      await writeFile(join(dir, "bun.lock"), "{}");
      await tscPart(dir);

      const bun = await readFile(join(dir, "tsconfig.json"), "utf8");

      expect(bun).not.toContain('"types"');
      expect(bun).not.toContain("__TYPES__");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
