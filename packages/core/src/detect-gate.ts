import { join } from "node:path";
import { ESLint } from "eslint";
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
const PRETTIER_BIN = join(ROOT, "node_modules", ".bin", "prettier");
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

/** Strict overlay for a project that ALREADY has a tsconfig: extend it (so the
 *  project's paths/jsx/module/lib still resolve — a bare strict config would
 *  mis-compile a real app) but FORCE every strictness flag on top, so a loosely-
 *  configured repo still gets tsforge's strict-TS floor. Written as a sibling
 *  `tsforge.tsconfig.json` and gated with `tsc -p`. */
const STRICT_TSCONFIG_OVERRIDE = `{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "noEmit": true
  }
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

/** One lint violation on a single file (errors only), for write-time feedback. */
export interface IFileLintProblem {
  line: number;
  message: string;
  ruleId: string;
}

/** Lint ONE just-written file, returning its errors. Reused per write. */
export type FileLinter = (absPath: string) => Promise<IFileLintProblem[]>;

/**
 * Build a WRITE-TIME single-file linter using the SAME bundled strict config as
 * the gate's eslint step. The write-guard type-checks each new file via tsc, but
 * tsc is blind to our STRICTNESS MOAT — the `no-as` cast ban, `I`-prefix, and
 * `prefer-template` are eslint rules. A run log showed the model writing
 * `Object.keys(x) as unknown as ...` in every domain file: type-valid, so the
 * type-guard waved it through, and 12 `as` violations piled up unseen until the
 * gate. This surfaces them inline the instant the file is written, so the model
 * fixes them in-context instead of in a late repair spiral.
 *
 * In-process via the ESLint API (config + parser loaded once and reused across
 * calls — no per-write cold start). Best-effort: a linter failure returns [] and
 * never breaks the build; the gate stays the authority. `cwd` is the app dir so
 * the vendored-code ignore globs (ui/, lib/, *.gen.ts) resolve correctly.
 */
export function makeFileLinter(
  framework: WebFramework | "core",
  cwd: string
): FileLinter {
  const overrideConfigFile =
    framework === "core" ? STRICT_CONFIG : STRICT_WEB_CONFIG;
  const ignores =
    framework === "core" ? [] : WEB_TEMPLATES[framework].eslintIgnore;
  let engine: ESLint | null = null;

  return async (absPath) => {
    try {
      engine ??= new ESLint({
        cwd,
        overrideConfigFile,
        ...(ignores.length > 0 ? { overrideConfig: [{ ignores }] } : {}),
      });

      const results = await engine.lintFiles([absPath]);
      const first = results[0];

      if (first === undefined) {
        return [];
      }

      return first.messages
        .filter((m) => m.severity === 2)
        .map((m) => ({
          line: m.line,
          message: m.message,
          ruleId: m.ruleId ?? "?",
        }));
    } catch {
      return [];
    }
  };
}

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
 * CLI prompt is conversational ("reply with the code") and carries the CORE
 * harness's TS house-rules (I-prefixed interfaces, no `as`). Both are WRONG for a
 * web build: it must write files via tools, and a Vite/React app's gate uses the
 * web lint config (no I-prefix, `as const` allowed). This block overrides both,
 * so the model writes conforming code up front instead of writing idiomatic code
 * and then "correcting" it toward rules the web gate never enforces.
 */
const BUILD_PREAMBLE = [
  "You are BUILDING this app. You produce files by CALLING TOOLS, not by writing",
  "them in your reply: a chat message is never saved to disk and cannot run.",
  "Call `create` once per file (relative path + full contents), ONE file per call,",
  "starting with the first file NOW — do not pre-write everything in prose. After",
  "you stop, the gate builds the app and reports what to fix; then edit and",
  "continue until it passes. Never paste file contents into your message.",
  "",
  "TYPE STYLE — the gate checks these; write them this way the FIRST time (the",
  "gate rejects code that breaks them, and fixing after costs extra turns):",
  "  • Interfaces are `I`-prefixed PascalCase: `interface IIssue`, `interface",
  "    IButtonProps` — NOT `Issue` / `ButtonProps`. Write the `I` from the start;",
  "    do not emit a bare name and then rename it. (Type ALIASES — `type Status =`",
  "    — are not prefixed.)",
  "  • `as const` IS allowed and PREFERRED for literal data and registries (e.g.",
  "    `const STATUS = {...} as const`). Still forbidden: `any`, value-changing",
  "    `as` casts, non-null `!`. Use `===`, never `var`.",
  "  • REGISTRIES (the #1 source of type errors): for an `as const` object, DERIVE",
  "    its types — `type Status = keyof typeof STATUSES`, `type StatusInfo =",
  "    (typeof STATUSES)[Status]`. Do NOT declare a separate interface the object",
  "    must match (its `readonly`/literal types won't assign → a wall of TS2322).",
  "    To VALIDATE a registry's shape, append `satisfies` — `const STATUSES = {...}",
  "    as const satisfies Record<string, IStatusInfo>` — it checks the shape while",
  "    keeping the literals, and is NOT an `as` cast (allowed). Need a typed key",
  "    array? `Object.keys(x)` is `string[]`; do NOT cast it — make the array the",
  "    source (`const STATUS_KEYS = [...] as const; type Status = (typeof",
  "    STATUS_KEYS)[number]`) and build the registry from it.",
  "",
  "Write it RIGHT the first time — these are the gate's hard rules; code that",
  "breaks them is rejected and costs you extra turns. The fixes are not optional",
  "polish, they are how you write the line:",
  "  • No `x as Foo`. Narrow instead: `if (!(x instanceof Foo)) return;` or a type",
  "    guard, or type the value at its source. For event targets, check the type.",
  "  • No `arr[i]!` / `obj.maybe!`. Guard: `const v = arr[i]; if (v === undefined)",
  "    return;` — array/Map index access is `T | undefined` here.",
  "  • No `any`. Use `unknown` + a narrow, or write the real type.",
  "  • Type every function parameter and every `useState`/`useRef` generic.",
  "",
  "Work directly — do NOT restate the task, announce a plan, or narrate progress",
  "between steps ('The user wants me to…', 'I was in the middle of…', 'Now let me…').",
  "That text is wasted. Emit the next tool call.",
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
  // GENERIC BEHAVIOUR SMOKE (--smoke): the gate proves the built app mounts in a
  // real browser AND survives interaction — it asserts the React root rendered
  // content (a blank white screen is a silent failure tsc/eslint never catch) and
  // clicks the first few buttons with zero uncaught/console errors. This is
  // HARNESS-authored and app-agnostic: we deliberately do NOT run a model-authored
  // checks.json — the 27b writes over-strict interaction assertions (exact
  // placeholders/fill flows) it then can't satisfy and spirals on (iter3/4).
  const render = `bun "${BROWSER_CHECK}" dist/index.html --smoke`;
  // Prettier enforces formatting (the fix step runs `prettier --write` first, so
  // this passes without the model ever hand-formatting). Respects .prettierignore
  // (vendored ui/ + lib/ skipped). Runs after lint so a parse error fails there.
  const format = `"${PRETTIER_BIN}" --check .`;

  return {
    command: `${build} && ${tsc} && ${lint} && ${format} && ${render}`,
    label: `${template.label} (build + behaviour smoke)`,
  };
}

/**
 * A TYPES-only gate for the staged DESIGN phase: `tsc --noEmit` + web eslint, but
 * NO vite build / browser (the app has no UI yet). This surfaces the `as const`↔
 * interface `TS2322` errors and the I-prefix/`as`-cast lint on the TYPE CONTRACT
 * ALONE — caught small and isolated, before any component is built — instead of
 * as a 20-error avalanche at the very end (the Linear-clone failure mode).
 */
export function buildWebTypeGate(framework: WebFramework): IGate {
  const template = WEB_TEMPLATES[framework];
  const ignores = template.eslintIgnore
    .map((glob) => `--ignore-pattern "${glob}"`)
    .join(" ");
  const tsc = `"${TSC_BIN}" --noEmit -p tsconfig.json`;
  const lint =
    `"${ESLINT_BIN}" --no-config-lookup -c "${STRICT_WEB_CONFIG}" ${ignores} --format json .`.replace(
      /\s+/g,
      " "
    );

  return { command: `${tsc} && ${lint}`, label: `${template.label} (types)` };
}

/** Just `tsc --noEmit` — the FAST incremental check run every few edits while
 *  building, so type errors (the avalanche source) surface early. Lint waits for
 *  the full gate (running it every few edits is noisy on half-written files). */
export function buildWebTscCheck(): string {
  return `"${TSC_BIN}" --noEmit -p tsconfig.json`;
}

/**
 * The web auto-fix command — the deterministic JANITOR, run BEFORE the gate each
 * cycle so the model NEVER spends (slow, costly) tokens on mechanical cleanup:
 *   1. `eslint --fix` — prefer-const, no-var, curly, inferrable types, AND the
 *      boringstack blank-lines (padding-line-between-statements is auto-fixable).
 *   2. `prettier --write` — all whitespace/quotes/semis/width formatting.
 * (Unused/missing imports are handled separately by the TS quick-fix pass.) The
 * unfixable rules (`any`/`as`/`!`) still need the model. Best-effort: exits ignored,
 * `;` so prettier runs even when eslint reports remaining (unfixable) errors.
 */
export function buildWebFix(framework: WebFramework): string {
  const ignores = WEB_TEMPLATES[framework].eslintIgnore
    .map((glob) => `--ignore-pattern "${glob}"`)
    .join(" ");

  const lintFix =
    `"${ESLINT_BIN}" --no-config-lookup -c "${STRICT_WEB_CONFIG}" ${ignores} --fix .`.replace(
      /\s+/g,
      " "
    );
  const format = `"${PRETTIER_BIN}" --write .`;

  return `${lintFix} ; ${format}`;
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

  const lint = lintPart();

  parts.push(lint.command);
  labels.push(lint.label);

  return { command: parts.join(" && "), label: labels.join(" + ") };
}

/**
 * The type-aware floor — ALWAYS tsforge-strict (user policy: a repo's own config
 * is never trusted to be strict enough). With a project tsconfig, extend it but
 * force the strict flags; greenfield, bring the full strict one. null when not a
 * TS project. (The strict override / bundled config win over whatever the repo set.)
 */
async function tscPart(cwd: string): Promise<string | null> {
  const hasTsconfig = await Bun.file(join(cwd, "tsconfig.json")).exists();

  if (hasTsconfig) {
    await Bun.write(
      join(cwd, "tsforge.tsconfig.json"),
      STRICT_TSCONFIG_OVERRIDE
    );

    return `"${TSC_BIN}" --noEmit -p tsforge.tsconfig.json`;
  }

  // Greenfield: bring a strict tsconfig so tsc can gate — but only when this is
  // actually a TS project (has a package.json), so we never litter a random dir.
  if (await Bun.file(join(cwd, "package.json")).exists()) {
    await Bun.write(join(cwd, "tsconfig.json"), STRICT_TSCONFIG);

    return `"${TSC_BIN}" --noEmit -p tsconfig.json`;
  }

  return null;
}

/** The syntactic idiom layer — ALWAYS tsforge's bundled strict eslint config
 *  (user policy). We deliberately do NOT defer to the project's own `lint`
 *  script: that's exactly how a weak repo would dodge the strict-TS floor. The
 *  bundled config needs no deps in the target. */
function lintPart(): IGate {
  return {
    command: `"${ESLINT_BIN}" --no-config-lookup -c "${STRICT_CONFIG}" --format json .`,
    label: "strict TypeScript (tsforge)",
  };
}
