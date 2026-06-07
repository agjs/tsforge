import { join } from "node:path";
import { isRecord } from "./lib/guards";
import { WEB_TEMPLATES, type WebFramework } from "./web-templates";

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
const BROWSER_CHECK = join(
  import.meta.dir,
  "..",
  "scripts",
  "browser-check.ts"
);

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

// The web-stack scaffolds (Vite + React full-kit, or Vite vanilla) live in the
// registry; this module just lays them down and builds their gate. shadcn/TanStack
// boilerplate is held to a web-tailored strict config (no `I`-prefix — React names
// interfaces `Props`, not `IProps`) with vendored/generated dirs exempted.
const STRICT_WEB_CONFIG = join(
  import.meta.dir,
  "..",
  "strict.web.eslint.config.mjs"
);

/** The frameworks the spec Q&A can scaffold. */
export const WEB_FRAMEWORKS: readonly WebFramework[] = ["react", "vanilla"];

/** Lay down a stack's opinionated skeleton (non-destructive — only missing files).
 *  Dependency install is separate (`installWebDeps`) so this stays pure + fast +
 *  offline-testable. */
export async function scaffoldWeb(
  cwd: string,
  framework: WebFramework
): Promise<void> {
  for (const [path, content] of Object.entries(
    WEB_TEMPLATES[framework].files
  )) {
    await ensureFile(cwd, path, content);
  }
}

/**
 * How a build turn must behave — prepended to every stack's guidance. The base
 * CLI prompt is conversational ("reply with the code"); for a BUILD that framing
 * makes the model paste whole files into its message, which never reaches disk.
 * This overrides it: produce files by calling tools, one `create` per file.
 */
const BUILD_PREAMBLE = [
  "You are BUILDING this app. You produce files by CALLING TOOLS, not by writing",
  "them in your reply: a chat message is never saved to disk and cannot run.",
  "Call `create` once per file (relative path + full contents), ONE file per call,",
  "starting with the first file NOW — do not pre-write everything in prose. After",
  "you stop, the gate builds the app and reports what to fix; then edit and",
  "continue until it passes. Never paste file contents into your message.",
].join("\n");

/** The system-prompt guidance for a stack (build framing + structure/conventions). */
export function webGuidance(framework: WebFramework): string {
  return `${BUILD_PREAMBLE}\n\n${WEB_TEMPLATES[framework].guidance}`;
}

/** Install the scaffold's dependencies (react/vite/tailwind/…) with bun, streaming
 *  progress to the terminal. Required before the gate's tsc + vite build can run.
 *  Skipped when deps are already present. Returns false on a failed install. */
export async function installWebDeps(cwd: string): Promise<boolean> {
  if (await Bun.file(join(cwd, "node_modules", ".bin", "vite")).exists()) {
    return true;
  }

  const proc = Bun.spawn(["bun", "install"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });

  return (await proc.exited) === 0;
}

/** The full web ladder: `vite build` + tsc strict + web eslint (vendored-exempt) +
 *  browser render of the built `dist/`. Build runs FIRST so any codegen (e.g.
 *  TanStack Router's routeTree.gen.ts) exists before tsc; `vite build` is itself
 *  the bundler oracle — it resolves imports, compiles JSX/Tailwind, fails on
 *  anything broken. */
export function buildWebGate(framework: WebFramework): IGate {
  const template = WEB_TEMPLATES[framework];
  const ignores = template.eslintIgnore
    .map((glob) => `--ignore-pattern "${glob}"`)
    .join(" ");
  const build = `bun run build`;
  const tsc = `"${TSC_BIN}" --noEmit -p tsconfig.json`;
  const lint =
    `"${ESLINT_BIN}" --no-config-lookup -c "${STRICT_WEB_CONFIG}" ${ignores} --format json .`.replace(
      /\s+/g,
      " "
    );
  const render = `bun "${BROWSER_CHECK}" dist/index.html checks.json`;

  return {
    command: `${build} && ${tsc} && ${lint} && ${render}`,
    label: `${template.label} (build + browser)`,
  };
}

async function ensureFile(
  cwd: string,
  name: string,
  content: string
): Promise<void> {
  const file = Bun.file(join(cwd, name));

  if (!(await file.exists())) {
    await Bun.write(file, content);
  }
}

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
