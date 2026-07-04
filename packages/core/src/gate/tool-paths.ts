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

// This module lives at `src/gate/`, so the package root (where the bundled eslint
// configs + `scripts/` live) is TWO levels up — `import.meta.dir/../..`.
const PKG_ROOT = join(import.meta.dir, "..", "..");

export const ESLINT_BIN = resolveToolBin("eslint");
export const TSC_BIN = resolveToolBin("tsc");
export const PRETTIER_BIN = resolveToolBin("prettier");
export const STRICT_CONFIG = join(PKG_ROOT, "strict.eslint.config.mjs");
export const TYPE_AWARE_CONFIG = join(
  PKG_ROOT,
  "strict.type-aware.eslint.config.mjs"
);
export const STRICT_WEB_CONFIG = join(PKG_ROOT, "strict.web.eslint.config.mjs");
export const BROWSER_CHECK = join(PKG_ROOT, "scripts", "browser-check.ts");
export const STUB_CHECK = join(PKG_ROOT, "scripts", "stub-check.ts");
export const TEST_COVERAGE_CHECK = join(
  PKG_ROOT,
  "scripts",
  "test-coverage-check.ts"
);
export const BOOT_CHECK = join(PKG_ROOT, "scripts", "boot-check.ts");
export const PROPTEST_CHECK = join(PKG_ROOT, "scripts", "proptest-check.ts");
