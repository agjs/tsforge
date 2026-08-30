import { join } from "node:path";
import { TSC_BIN } from "./tool-paths";
import { shellQuote } from "../lib/fs";
import { isRecord } from "../lib/guards";
import { listChildPackageRoots } from "./workspace-root";

// The strict tsconfig tsforge brings to a greenfield project — strict + the
// index-safety the local model is weakest at, with DOM + JSX libs so browser /
// React code type-checks, and skipLibCheck so it never trips on dep .d.ts.
// `__TYPES__` is replaced with a `"types"` line (or nothing) per project, so a
// Bun package gets its runtime globals (`Bun`, `bun:test`) instead of hundreds
// of phantom cannot-find-name errors.
const STRICT_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
__TYPES__    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "erasableSyntaxOnly": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules", "dist", "build", "scratch"]
}
`;

/** Strict overlay for a project that ALREADY has a tsconfig: extend it (so the
 *  project's paths/jsx/module/lib still resolve — a bare strict config would
 *  mis-compile a real app) but FORCE every strictness flag on top, so a loosely-
 *  configured repo still gets tsforge's strict-TS floor.
 *
 *  PERSISTENCE POLICY: written under `.tsforge/` (tsforge's cache namespace), NOT
 *  as a sibling in the project root — so the gate never litters the user's repo
 *  with a `tsforge.tsconfig.json`. `extends` points one level up to the project's
 *  own config, and `include`/`exclude` are re-stated relative to the subdir
 *  because `extends` does not inherit them (they default to the config's own
 *  directory otherwise — which under `.tsforge/` would compile nothing). */
/* `extends` merges compilerOptions PER FIELD, and `strict` is only a DEFAULT for
 * its sub-flags: a base config's explicit `"strictNullChecks": false` beats the
 * overlay's `"strict": true`. So every strict-family sub-flag is enumerated
 * explicitly — otherwise a loosely-configured (or model-loosened) project
 * tsconfig silently disables parts of the floor the gate claims to enforce. */
const STRICT_TSCONFIG_OVERLAY = `{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "strictBuiltinIteratorReturn": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["../**/*.ts", "../**/*.tsx"],
  "exclude": ["../node_modules", "../dist", "../build", "../scratch", "../.tsforge"]
}
`;

/** The greenfield strict tsconfig with the `__TYPES__` slot resolved for `cwd`:
 *  a Bun package (bun lockfile / packageManager / engines.bun) gets a `"types"`
 *  entry for whichever Bun type package is actually installed, so `Bun`,
 *  `bun:test`, and `import.meta.dir` type-check; everything else gets no line. */
export async function strictTsconfigFor(cwd: string): Promise<string> {
  const types = (await usesBun(cwd)) ? await bunTypesPackage(cwd) : null;
  const line = types === null ? "" : `    "types": ["${types}"],\n`;

  return STRICT_TSCONFIG.replace("__TYPES__", line);
}

/** Bun runtime markers: a lockfile, or a bun packageManager/engines pin. */
async function usesBun(cwd: string): Promise<boolean> {
  if (
    (await Bun.file(join(cwd, "bun.lock")).exists()) ||
    (await Bun.file(join(cwd, "bun.lockb")).exists())
  ) {
    return true;
  }

  try {
    const pkg: unknown = JSON.parse(
      await Bun.file(join(cwd, "package.json")).text()
    );

    if (!isRecord(pkg)) {
      return false;
    }

    return (
      (typeof pkg.packageManager === "string" &&
        pkg.packageManager.startsWith("bun@")) ||
      (isRecord(pkg.engines) && "bun" in pkg.engines)
    );
  } catch {
    return false;
  }
}

/** The INSTALLED Bun type package's name (`@types/bun` or `bun-types`), or null
 *  when neither resolves — a `"types"` entry naming an absent package trades the
 *  phantom-global flood for a hard TS2688, so only ever point at a real one. */
async function bunTypesPackage(cwd: string): Promise<string | null> {
  for (const name of ["@types/bun", "bun-types"]) {
    if (
      await Bun.file(join(cwd, "node_modules", name, "package.json")).exists()
    ) {
      return name;
    }
  }

  return null;
}

/** The gate overlay's home: tsforge's cache dir + the overlay filename. */
const GATE_TSCONFIG_DIR = ".tsforge";
const GATE_TSCONFIG_FILE = "tsconfig.gate.json";

/**
 * Model-facing one-liner for the gate TypeScript floor (must stay aligned with
 * STRICT_TSCONFIG / OVERLAY — both set strict + noUncheckedIndexedAccess).
 */
export const GATE_TYPECHECK_IDENTITY =
  "Typecheck: strict + noUncheckedIndexedAccess (gate tsconfig — stricter than a loose project tsconfig)";

/** The project's own TypeScript config (the model-editable one). */
export const PROJECT_TSCONFIG = "tsconfig.json";
/** Persistent incremental-typecheck cache (in .tsforge/, git-ignored). Reused
 *  across settles so a warm `tsc` only re-checks what changed — tsc stays the
 *  authority, just amortized. */
const GATE_TSBUILDINFO_FILE = "gate.tsbuildinfo";
const INCREMENTAL_FLAGS = `--incremental --tsBuildInfoFile ${GATE_TSCONFIG_DIR}/${GATE_TSBUILDINFO_FILE}`;
/** The syntactic-lint result cache (`.tsforge/eslint-gate-<rulesetHash>.cache`, see
 *  core-gate.ts — the path is keyed by the active ruleset). A glob so every per-ruleset
 *  cache file (and the pre-hash `eslint-gate.cache` from older runs) is git-ignored
 *  alongside the tsc buildinfo, so a warm gate never shows a cache file in `git status`. */
const GATE_ESLINT_CACHE_FILE = "eslint-gate*.cache";

/** Compute new `.gitignore` content with any missing `entries` appended, PRESERVING
 *  the file's EOL style (a CRLF file stays all-CRLF — appending `\n` after CRLF
 *  lines produced mixed endings; mirrors the issue #24 fuzzy-edit fix). Returns null
 *  when nothing is missing, so the caller skips a no-op write. */
function gitignoreWithEntries(
  current: string,
  entries: readonly string[]
): string | null {
  const have = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !have.has(entry));

  if (missing.length === 0) {
    return null;
  }

  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const base = current.replace(/(?:\r?\n)+$/u, "");
  const prefix = base.length > 0 ? `${base}${eol}` : "";

  return `${prefix}${missing.join(eol)}${eol}`;
}

/**
 * The type-aware floor — ALWAYS tsforge-strict (user policy: a repo's own config
 * is never trusted to be strict enough). With a project tsconfig, extend it under
 * `.tsforge/` but force the strict flags; greenfield, bring the full strict one.
 * null when not a TS project. (The strict overlay / bundled config win over
 * whatever the repo set.)
 */
export async function tscPart(cwd: string): Promise<string | null> {
  const hasTsconfig = await Bun.file(join(cwd, PROJECT_TSCONFIG)).exists();

  if (hasTsconfig) {
    // EPHEMERAL gate artifact: lives in .tsforge/ (Bun.write makes the dir), so
    // we never drop a tsforge.tsconfig.json in the user's project root.
    await Bun.write(
      join(cwd, GATE_TSCONFIG_DIR, GATE_TSCONFIG_FILE),
      STRICT_TSCONFIG_OVERLAY
    );
    await ignoreGateArtifact(cwd);

    return `${shellQuote(TSC_BIN)} --noEmit ${INCREMENTAL_FLAGS} -p ${GATE_TSCONFIG_DIR}/${GATE_TSCONFIG_FILE}`;
  }

  // Greenfield: bring a strict tsconfig so tsc can gate — but only when this is
  // actually a TS project (has a package.json), so we never litter a random dir.
  // A root with CHILD packages nested below it is never greenfield, whatever its
  // own manifest looks like: a whole-tree strict tsconfig at a monorepo root
  // sweeps every package under one config that owns none of their types/paths
  // (observed: 708 phantom errors in a Bun monorepo, then quick-fix vandalism
  // driven by those phantoms). Those roots gate per package or not at all.
  // Unlike the overlay, a greenfield tsconfig.json is a DURABLE project file.
  if (
    (await Bun.file(join(cwd, "package.json")).exists()) &&
    listChildPackageRoots(cwd).length === 0
  ) {
    await Bun.write(join(cwd, PROJECT_TSCONFIG), await strictTsconfigFor(cwd));
    // The buildinfo lives in .tsforge/ (git-ignored), NOT next to the durable
    // tsconfig — so incremental never leaks a cache file into the user's tree.
    await ignoreGateArtifact(cwd);

    return `${shellQuote(TSC_BIN)} --noEmit ${INCREMENTAL_FLAGS} -p tsconfig.json`;
  }

  return null;
}

/** Keep the ephemeral gate overlay out of git WITHOUT touching the user's root
 *  .gitignore: drop a scoped `.tsforge/.gitignore` ignoring just the overlay.
 *  Created only when absent, so a user-authored `.tsforge/.gitignore` (e.g. one
 *  that intentionally tracks rules.json) is never clobbered. */
async function ignoreGateArtifact(cwd: string): Promise<void> {
  const ignore = join(cwd, GATE_TSCONFIG_DIR, ".gitignore");
  const entries = [
    GATE_TSCONFIG_FILE,
    GATE_TSBUILDINFO_FILE,
    GATE_ESLINT_CACHE_FILE,
  ];
  const file = Bun.file(ignore);

  if (!(await file.exists())) {
    await Bun.write(ignore, `${entries.join("\n")}\n`);

    return;
  }

  // Exists (maybe a user's, or an older tsforge one without the buildinfo line):
  // append only the missing entries so we never clobber what's there.
  const next = gitignoreWithEntries(await file.text(), entries);

  if (next !== null) {
    await Bun.write(ignore, next);
  }
}
