import { join } from "node:path";
import { isRecord } from "./lib/guards";

/**
 * Build the gate that confirms "done" — and makes tsforge a TypeScript-SPECIALIZED
 * harness, not a generic file editor. It enforces strict TS on whatever the model
 * writes, in two layers, using tsforge's OWN bundled toolchain so it works on any
 * target regardless of that project's setup:
 *   1. `tsc --strict --noUncheckedIndexedAccess` — the TYPE-aware floor (unguarded
 *      `arr[i]`, null-safety, real type errors). Greenfield gets a strict tsconfig
 *      brought in; an existing project's own tsconfig is respected.
 *   2. the bundled eslint strict config — the SYNTACTIC idioms (no `as`/`any`/`!`,
 *      no over-annotation), which need no type info or deps.
 * The deterministic gate loop + rule-docs cards + ast-grep polish then drive the
 * local model's output up to that bar — that's the uplift.
 */
export interface IGate {
  /** The shell command run to verify (must exit 0). */
  command: string;
  /** A short human label for the banner. */
  label: string;
}

// tsforge's own toolchain, resolved from this module's location so it's found
// wherever the harness lives.
const ROOT = join(import.meta.dir, "..", "..", "..");
const ESLINT_BIN = join(ROOT, "node_modules", ".bin", "eslint");
const TSC_BIN = join(ROOT, "node_modules", ".bin", "tsc");
const STRICT_CONFIG = join(import.meta.dir, "..", "strict.eslint.config.mjs");

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
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules", "dist", "build", "scratch"]
}
`;

export async function buildGate(cwd: string): Promise<IGate> {
  const parts: string[] = [];
  const labels: string[] = [];

  const tsc = await tscPart(cwd);

  if (tsc !== null) {
    parts.push(tsc);
    labels.push("tsc --strict");
  }

  const lint = await lintPart(cwd);

  parts.push(lint.command);
  labels.push(lint.label);

  return { command: parts.join(" && "), label: labels.join(" + ") };
}

/** The type-aware floor: `tsc --noEmit` against the project's tsconfig (bringing a
 *  strict one if the project is TS but unconfigured). null when not a TS project. */
async function tscPart(cwd: string): Promise<string | null> {
  const hasTsconfig = await Bun.file(join(cwd, "tsconfig.json")).exists();

  if (hasTsconfig) {
    return `"${TSC_BIN}" --noEmit -p tsconfig.json`;
  }

  // Greenfield: bring a strict tsconfig so tsc can gate — but only when this is
  // actually a TS project (has a package.json), so we never litter a random dir.
  if (await Bun.file(join(cwd, "package.json")).exists()) {
    await Bun.write(join(cwd, "tsconfig.json"), STRICT_TSCONFIG);

    return `"${TSC_BIN}" --noEmit -p tsconfig.json`;
  }

  return null;
}

/** The syntactic idiom layer: the project's own `lint` script, else tsforge's
 *  bundled strict eslint config (which needs no deps in the target). */
async function lintPart(cwd: string): Promise<IGate> {
  const pkg = await readPackageJson(cwd);
  const scripts = pkg !== null && isRecord(pkg.scripts) ? pkg.scripts : {};

  if (typeof scripts.lint === "string") {
    const runner = await detectPackageManager(cwd);

    return { command: `${runner} run lint`, label: "project lint" };
  }

  return {
    command: `"${ESLINT_BIN}" --no-config-lookup -c "${STRICT_CONFIG}" --format json .`,
    label: "strict TypeScript (tsforge)",
  };
}

async function readPackageJson(
  cwd: string
): Promise<Record<string, unknown> | null> {
  const file = Bun.file(join(cwd, "package.json"));

  if (!(await file.exists())) {
    return null;
  }

  try {
    const data: unknown = JSON.parse(await file.text());

    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** Pick the package manager by lockfile, defaulting to npm. */
async function detectPackageManager(cwd: string): Promise<string> {
  const byLockfile: [string, string][] = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
  ];

  for (const [lockfile, manager] of byLockfile) {
    if (await Bun.file(join(cwd, lockfile)).exists()) {
      return manager;
    }
  }

  return "npm";
}
