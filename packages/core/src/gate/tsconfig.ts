import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { TSC_BIN } from "./tool-paths";

// The strict tsconfig tsforge brings to a greenfield project — strict + the
// index-safety the local model is weakest at, with DOM + JSX libs so browser /
// React code type-checks, and skipLibCheck so it never trips on dep .d.ts.
const STRICT_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
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
const STRICT_TSCONFIG_OVERLAY = `{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "strict": true,
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

/** The gate overlay's home: tsforge's cache dir + the overlay filename. */
const GATE_TSCONFIG_DIR = ".tsforge";
const GATE_TSCONFIG_FILE = "tsconfig.gate.json";

/** The project's own TypeScript config (the model-editable one). */
export const PROJECT_TSCONFIG = "tsconfig.json";
/** Persistent incremental-typecheck cache (in .tsforge/, git-ignored). Reused
 *  across settles so a warm `tsc` only re-checks what changed — tsc stays the
 *  authority, just amortized. */
const GATE_TSBUILDINFO_FILE = "gate.tsbuildinfo";
const INCREMENTAL_FLAGS = `--incremental --tsBuildInfoFile ${GATE_TSCONFIG_DIR}/${GATE_TSBUILDINFO_FILE}`;
/** The syntactic-lint result cache (`.tsforge/eslint-gate.cache`, see
 *  core-gate.ts). Git-ignored alongside the tsc buildinfo so a warm gate never
 *  shows a cache file in `git status`. */
const GATE_ESLINT_CACHE_FILE = "eslint-gate.cache";

/** The web gate typechecks through this HARNESS-OWNED overlay, NOT the project's
 *  own tsconfig.json. That file is model-editable and tooling (shadcn init, the
 *  model fixing a path) routinely rewrites it and drops the test-file exclude.
 *  When the exclude is gone, tsc pulls the model's co-located test files into the
 *  program and their `import … from "bun:test"` becomes a gate-failing TS2307 —
 *  `bun:test` is a Bun runtime module that `bun test` resolves natively but tsc
 *  can't (it needs the exclude OR @types/bun, and neither is guaranteed to survive
 *  an install flake / a rewrite). The overlay extends the project config (so paths/
 *  jsx/lib still resolve) but FORCES the exclude, so test files are run by `bun test`
 *  and never typechecked — robust to any rewrite of tsconfig.json. (Mirrors the core
 *  gate's `.tsforge/tsconfig.gate.json` overlay.) */
const WEB_GATE_TSCONFIG_FILE = "tsconfig.web-gate.json";
const STRICT_WEB_TSCONFIG_OVERLAY = `{
  "extends": "../tsconfig.json",
  "compilerOptions": { "noEmit": true, "skipLibCheck": true },
  "include": ["../**/*.ts", "../**/*.tsx"],
  "exclude": ["../node_modules", "../dist", "../build", "../.tsforge", "../**/*.test.ts", "../**/*.test.tsx"]
}
`;

/** Write the web-gate tsconfig overlay under `.tsforge/` and return the `tsc -p`
 *  target for it. Falls back to the project tsconfig when none exists yet (called
 *  before scaffolding) — the gate is rebuilt once the project is laid down. Sync +
 *  idempotent so the synchronous gate builders can call it without a signature
 *  change. */
export function ensureWebGateTsconfig(cwd: string): string {
  if (!existsSync(join(cwd, PROJECT_TSCONFIG))) {
    return PROJECT_TSCONFIG;
  }

  const dir = join(cwd, GATE_TSCONFIG_DIR);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, WEB_GATE_TSCONFIG_FILE), STRICT_WEB_TSCONFIG_OVERLAY);
  ensureGateIgnore(dir);

  return `${GATE_TSCONFIG_DIR}/${WEB_GATE_TSCONFIG_FILE}`;
}

/** Keep tsforge's `.tsforge/` cache artifacts out of git WITHOUT clobbering a
 *  pre-existing `.tsforge/.gitignore` (a previous core-gate run, or one the user
 *  authored): create it if absent, otherwise APPEND only the entries it's missing
 *  so the web-gate overlay never shows up in `git status`. */
function ensureGateIgnore(dir: string): void {
  const ignore = join(dir, ".gitignore");
  const entries = [
    WEB_GATE_TSCONFIG_FILE,
    GATE_TSCONFIG_FILE,
    GATE_TSBUILDINFO_FILE,
  ];

  if (!existsSync(ignore)) {
    writeFileSync(ignore, `${entries.join("\n")}\n`);

    return;
  }

  const next = gitignoreWithEntries(readFileSync(ignore, "utf8"), entries);

  if (next !== null) {
    writeFileSync(ignore, next);
  }
}

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

    return `"${TSC_BIN}" --noEmit ${INCREMENTAL_FLAGS} -p ${GATE_TSCONFIG_DIR}/${GATE_TSCONFIG_FILE}`;
  }

  // Greenfield: bring a strict tsconfig so tsc can gate — but only when this is
  // actually a TS project (has a package.json), so we never litter a random dir.
  // Unlike the overlay, a greenfield tsconfig.json is a DURABLE project file.
  if (await Bun.file(join(cwd, "package.json")).exists()) {
    await Bun.write(join(cwd, PROJECT_TSCONFIG), STRICT_TSCONFIG);
    // The buildinfo lives in .tsforge/ (git-ignored), NOT next to the durable
    // tsconfig — so incremental never leaks a cache file into the user's tree.
    await ignoreGateArtifact(cwd);

    return `"${TSC_BIN}" --noEmit ${INCREMENTAL_FLAGS} -p tsconfig.json`;
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
