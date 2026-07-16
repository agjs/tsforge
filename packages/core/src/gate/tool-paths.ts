import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

// tsforge's own toolchain, resolved from this module's location so it's found
// wherever the harness lives. We walk UP from this file to the nearest
// `node_modules/.bin` that actually has the tool, which is correct in BOTH
// layouts tsforge ships in: the monorepo (deps hoisted to <repo>/node_modules)
// AND a published install, where the deps are hoisted into the install's
// node_modules and an ANCESTOR dir is itself `node_modules`. The old
// `../../../node_modules/.bin` hard-coding only matched the monorepo; once
// published it pointed at `.../node_modules/node_modules/.bin` and the CLI
// crashed on startup the moment it touched the toolchain.
function resolveToolBin(name: string): string {
  let dir = import.meta.dir;
  let parent = dirname(dir);

  while (parent !== dir) {
    const hoisted = join(dir, "node_modules", ".bin", name);

    if (existsSync(hoisted)) {
      return hoisted;
    }

    // When `dir` is itself a `node_modules` (the published/global-install case),
    // the .bin sits directly inside it.
    const direct = join(dir, ".bin", name);

    if (existsSync(direct)) {
      return direct;
    }

    dir = parent;
    parent = dirname(dir);
  }

  // Last resort: let the shell resolve it from PATH rather than a wrong abspath.
  return name;
}

// TypeScript 7 (the Go-native compiler, ~10x faster typecheck) ships as the
// `@typescript/native` package so it can coexist with the `typescript` package,
// whose 6.x programmatic API our tooling (typescript-eslint, proptest) still
// needs — TS7 has no stable programmatic API until 7.1. It is a real dependency
// of this package, so consumers get it too (the gate typechecks on TS7
// everywhere, not just in-repo). Both packages expose a `tsc` bin, so `.bin/tsc`
// is ambiguous; resolve TS7's compiler by its package path instead. The plain
// `tsc` fallback is only a defensive safety net (should never fire given the
// dependency) that keeps the gate functional on TS6 rather than crashing.
export function resolveTs7Tsc(startDir: string = import.meta.dir): string {
  let dir = startDir;
  let parent = dirname(dir);

  while (parent !== dir) {
    // Hoisted (monorepo): <dir>/node_modules/@typescript/native/bin/tsc.
    const hoisted = join(
      dir,
      "node_modules",
      "@typescript",
      "native",
      "bin",
      "tsc"
    );

    if (existsSync(hoisted)) {
      return hoisted;
    }

    // Published/global install where `dir` is itself a `node_modules`: the
    // package sits directly inside it (same double-`node_modules` case
    // resolveToolBin handles). Without this, a consumer install misses TS7.
    const direct = join(dir, "@typescript", "native", "bin", "tsc");

    if (existsSync(direct)) {
      return direct;
    }

    dir = parent;
    parent = dirname(dir);
  }

  // @typescript/native is a dependency, so a miss is unexpected — say so LOUDLY
  // (not a silent downgrade) before falling back to an ambient tsc so the gate
  // degrades instead of crashing.
  process.stderr.write(
    "tsforge: @typescript/native (TypeScript 7) not found — the gate is falling back to an ambient `tsc`, which may be TS6 or another version.\n"
  );

  return resolveToolBin("tsc");
}

// This module lives at `src/gate/`, so the package root (where the bundled eslint
// configs + `scripts/` live) is TWO levels up — `import.meta.dir/../..`.
const PKG_ROOT = join(import.meta.dir, "..", "..");

export const ESLINT_BIN = resolveToolBin("eslint");
export const TSC_BIN = resolveTs7Tsc();
export const PRETTIER_BIN = resolveToolBin("prettier");
export const STRICT_CONFIG = join(PKG_ROOT, "strict.eslint.config.mjs");
export const TYPE_AWARE_CONFIG = join(
  PKG_ROOT,
  "strict.type-aware.eslint.config.mjs"
);
export const STUB_CHECK = join(PKG_ROOT, "scripts", "stub-check.ts");
export const TEST_COVERAGE_CHECK = join(
  PKG_ROOT,
  "scripts",
  "test-coverage-check.ts"
);
export const BOOT_CHECK = join(PKG_ROOT, "scripts", "boot-check.ts");
export const PROPTEST_CHECK = join(PKG_ROOT, "scripts", "proptest-check.ts");
