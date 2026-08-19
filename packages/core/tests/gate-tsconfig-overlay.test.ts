import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
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
