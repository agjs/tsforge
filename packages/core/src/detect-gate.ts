import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { ESLint } from "eslint";
import { WEB_TEMPLATES, type WebFramework } from "./web-templates";
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

const ESLINT_BIN = resolveToolBin("eslint");
const TSC_BIN = resolveToolBin("tsc");
const PRETTIER_BIN = resolveToolBin("prettier");
const STRICT_CONFIG = join(import.meta.dir, "..", "strict.eslint.config.mjs");
const TYPE_AWARE_CONFIG = join(
  import.meta.dir,
  "..",
  "strict.type-aware.eslint.config.mjs"
);
const BROWSER_CHECK = join(
  import.meta.dir,
  "..",
  "scripts",
  "browser-check.ts"
);

const STUB_CHECK = join(import.meta.dir, "..", "scripts", "stub-check.ts");
const TEST_COVERAGE_CHECK = join(
  import.meta.dir,
  "..",
  "scripts",
  "test-coverage-check.ts"
);
const BOOT_CHECK = join(import.meta.dir, "..", "scripts", "boot-check.ts");
const PROPTEST_CHECK = join(
  import.meta.dir,
  "..",
  "scripts",
  "proptest-check.ts"
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
/** Persistent incremental-typecheck cache (in .tsforge/, git-ignored). Reused
 *  across settles so a warm `tsc` only re-checks what changed — tsc stays the
 *  authority, just amortized. */
const GATE_TSBUILDINFO_FILE = "gate.tsbuildinfo";
const INCREMENTAL_FLAGS = `--incremental --tsBuildInfoFile ${GATE_TSCONFIG_DIR}/${GATE_TSBUILDINFO_FILE}`;

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
 *
 * When `packIds` is provided, those rule packs are added to the config via
 * `overrideConfig` (applies after the bundled config). This allows write-time
 * feedback on stack-aware rules. `ruleOverrides` (keyed by bare rule name) can
 * tune severities or silence rules ("off").
 */
export function makeFileLinter(
  framework: WebFramework | "core",
  cwd: string,
  packIds?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>
): FileLinter {
  const overrideConfigFile =
    framework === "core" ? STRICT_CONFIG : STRICT_WEB_CONFIG;
  const ignores =
    framework === "core" ? [] : WEB_TEMPLATES[framework].eslintIgnore;
  let engine: ESLint | null = null;

  return async (absPath) => {
    try {
      if (engine === null) {
        interface IEslintOptions {
          cwd: string;
          overrideConfigFile: string;
          overrideConfig?: Record<string, unknown>[];
        }

        const eOpts: IEslintOptions = {
          cwd,
          overrideConfigFile,
        };

        // Add ignores config if needed
        if (ignores.length > 0) {
          eOpts.overrideConfig = [{ ignores }];
        }

        // Add pack rules if provided
        if (packIds !== undefined && packIds.length > 0) {
          const { buildPackEslintConfig } = await import("./rule-packs/index");

          const { plugin, rules } = buildPackEslintConfig(
            packIds,
            ruleOverrides
          );

          const packConfig: Record<string, unknown> = {
            files: ["**/*.ts", "**/*.tsx"],
            plugins: { tsforge: plugin },
            rules,
          };

          eOpts.overrideConfig =
            eOpts.overrideConfig !== undefined
              ? [...eOpts.overrideConfig, packConfig]
              : [packConfig];
        }

        engine = new ESLint(eOpts);
      }

      const results = await engine.lintFiles([absPath]);
      const first = results[0];

      if (first === undefined) {
        return [];
      }

      // ONLY surface errors the model must fix BY HAND. ESLint sets `fix` on a
      // message when the rule is auto-fixable — those (padding-line, quotes, semis,
      // curly, prefer-const…) are squashed by the gate's `eslint --fix`/`prettier`
      // janitor for free, so nagging the model about them just burns turns and, for
      // interdependent rules like padding-line, OSCILLATES (fix one blank line, the
      // rule flags the next) — a real thrash we saw in a run log. Keep only the
      // hand-fix-required rules: `as`-casts, `any`, I-prefix, one-component, etc.
      return first.messages
        .filter((m) => m.severity === 2 && m.fix === undefined)
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
  "  • SEED/DATA arrays: an UNANNOTATED literal widens (`priority: 'high'` becomes",
  "    `string`), so it won't fit `IThing[]` and you CANNOT cast it (`as` is banned).",
  "    Always pin the type ONE of two ways, then write PLAIN literals (no per-field",
  "    `as`): annotate — `const SEED: readonly IThing[] = [...]` — OR append",
  "    `satisfies` — `const SEED = [...] satisfies readonly IThing[]` (also flags a",
  "    WRONG enum value, e.g. a `priority` not in the union). A literal that's a member",
  "    of the union is already assignable; never write `'high' as Priority`.",
  "  • No `arr[i]!` / `obj.maybe!`. Guard: `const v = arr[i]; if (v === undefined)",
  "    return;` — array/Map index access is `T | undefined` here.",
  "  • No `any`. Use `unknown` + a narrow, or write the real type.",
  "  • Type every function parameter and every `useState`/`useRef` generic.",
  "",
  "Work directly — do NOT restate the task, announce a plan, or narrate progress",
  "between steps ('The user wants me to…', 'I was in the middle of…', 'Now let me…').",
  "That text is wasted. Emit the next tool call.",
  "",
  "NO COMMENTS in the code you write. A comment is generated text that costs you",
  "time, and these add nothing: file-header banners that restate the filename,",
  "decorative section dividers, and lines that restate the code or narrate where a",
  "symbol is defined. Write self-explanatory names instead. The ONLY allowed comment",
  "explains a non-obvious WHY the code cannot — most files need none. No JSDoc.",
].join("\n");

/** The system-prompt guidance for a stack (build framing + structure/conventions). */
export function webGuidance(framework: WebFramework): string {
  return `${BUILD_PREAMBLE}\n\n${WEB_TEMPLATES[framework].guidance}`;
}

/** Install the scaffold's dependencies (react/vite/tailwind/…) with bun, streaming
 *  progress to the terminal. Required before the gate's tsc + vite build can run.
 *  Skipped when deps are already present. Returns false on a failed install. */
export async function installWebDeps(cwd: string): Promise<boolean> {
  if (!(await Bun.file(join(cwd, "node_modules", ".bin", "vite")).exists())) {
    const proc = Bun.spawn(["bun", "install"], {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    });

    if ((await proc.exited) !== 0) {
      return false;
    }
  }

  return true;
}

/** The full web ladder: `vite build` + tsc strict + web eslint (vendored-exempt) +
 *  browser render of the built `dist/`. Build runs FIRST so any codegen (e.g.
 *  TanStack Router's routeTree.gen.ts) exists before tsc; `vite build` is itself
 *  the bundler oracle — it resolves imports, compiles JSX/Tailwind, fails on
 *  anything broken. */
/** The packs the WEB eslint config must load by default so the React component
 *  architecture rules (component-folder-structure, component-file-purity,
 *  no-jsx-computation, …) actually run on a generated app. The web scaffold's
 *  stack is fixed (React + TanStack), so this set is deterministic; callers may
 *  pass a detected/overridden set instead. Without this the web gate ran the
 *  bundled config with ZERO packs and the whole architecture layer was inert. */
export const WEB_PACKS: readonly string[] = [
  "typescript-core",
  "react",
  "react-component-architecture",
  "tanstack-query",
];

/** POSIX-safe single-quote a value for interpolation into a `sh -c` command:
 *  wrap in single quotes and rewrite each embedded `'` as `'\''` (close quote,
 *  escaped quote, reopen). Single quoting is required because the value is a JSON
 *  blob — left unquoted, the shell strips its double quotes (`{"a":"off"}` →
 *  `{a:off}`), which fails `JSON.parse` in the config and is silently ignored, so
 *  rule overrides never reached eslint. Escaping the embedded quote is required
 *  because a pack id or rule key can carry a `'` (e.g. from a malicious
 *  tsforge.config.json in an untrusted repo) — naive single-quoting would let it
 *  break out and inject shell commands. */
function shSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Build the `KEY='val' ` shell prefix that hands packs (+ rule overrides) to a
 *  bundled eslint config, which reads them from the environment at load time. */
function packEnvPrefix(
  packs?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>
): string {
  const envParts: string[] = [];

  if (packs !== undefined && packs.length > 0) {
    envParts.push(`TSFORGE_PACKS=${shSingleQuote(packs.join(","))}`);
  }

  if (ruleOverrides !== undefined && Object.keys(ruleOverrides).length > 0) {
    envParts.push(
      `TSFORGE_RULE_OVERRIDES=${shSingleQuote(JSON.stringify(ruleOverrides))}`
    );
  }

  return envParts.length > 0 ? `${envParts.join(" ")} ` : "";
}

export function buildWebGate(
  framework: WebFramework,
  packs: readonly string[] = WEB_PACKS,
  cwd: string = process.cwd()
): IGate {
  const template = WEB_TEMPLATES[framework];
  const ignores = template.eslintIgnore
    .map((glob) => `--ignore-pattern "${glob}"`)
    .join(" ");
  const build = `bun run build`;
  const tsc = `"${TSC_BIN}" --noEmit -p tsconfig.json`;
  const lint =
    `${packEnvPrefix(packs)}bun "${ESLINT_BIN}" --no-config-lookup -c "${STRICT_WEB_CONFIG}" ${ignores} --format json .`.replace(
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
  // OPT-IN quality oracles (default OFF so existing web runs are unchanged):
  // TSFORGE_A11Y=1 adds axe (serious/critical fail), TSFORGE_SCREENSHOTS=1 writes
  // per-route PNGs. A "frontend"/"strict" profile can set these.
  const a11y = process.env.TSFORGE_A11Y === "1" ? " --a11y" : "";
  const shots = process.env.TSFORGE_SCREENSHOTS === "1" ? " --screenshots" : "";
  const render = `bun "${BROWSER_CHECK}" dist/index.html --smoke --crawl${a11y}${shots}`;
  // Prettier enforces formatting (the fix step runs `prettier --write` first, so
  // this passes without the model ever hand-formatting). Respects .prettierignore
  // (vendored ui/ + lib/ skipped). Runs after lint so a parse error fails there.
  const format = `"${PRETTIER_BIN}" --check .`;

  // Fail if any route is still an unfilled scaffold stub (empty page that coverage
  // + the render smoke both miss). Runs before the browser so the cheap check
  // fails fast.
  const stubs = `bun "${STUB_CHECK}" .`;

  // Type-aware async correctness (no-floating-promises / no-misused-promises) —
  // the CORE gate already runs this via typeAwareLintPart(), but the web gate
  // historically did not, so a dropped `await` in a handler/effect/mutation passed.
  // Splice it in after the syntactic lint when the scaffold has a tsconfig (it
  // always does), reusing the SHIPPED strict.type-aware config verbatim.
  const typeAware = existsSync(join(cwd, "tsconfig.json"))
    ? `bun "${ESLINT_BIN}" --no-config-lookup -c "${TYPE_AWARE_CONFIG}" ${ignores} --format json .`.replace(
        /\s+/g,
        " "
      )
    : null;
  const lintChain = typeAware === null ? lint : `${lint} && ${typeAware}`;

  return {
    command: `${build} && ${tsc} && ${lintChain} && ${stubs} && ${format} && ${render}`,
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
export function buildWebTypeGate(
  framework: WebFramework,
  packs: readonly string[] = WEB_PACKS
): IGate {
  const template = WEB_TEMPLATES[framework];
  const ignores = template.eslintIgnore
    .map((glob) => `--ignore-pattern "${glob}"`)
    .join(" ");
  const tsc = `"${TSC_BIN}" --noEmit -p tsconfig.json`;
  const lint =
    `${packEnvPrefix(packs)}bun "${ESLINT_BIN}" --no-config-lookup -c "${STRICT_WEB_CONFIG}" ${ignores} --format json .`.replace(
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
export function buildWebFix(
  framework: WebFramework,
  packs: readonly string[] = WEB_PACKS
): string {
  const ignores = WEB_TEMPLATES[framework].eslintIgnore
    .map((glob) => `--ignore-pattern "${glob}"`)
    .join(" ");

  const lintFix =
    `${packEnvPrefix(packs)}bun "${ESLINT_BIN}" --no-config-lookup -c "${STRICT_WEB_CONFIG}" ${ignores} --fix .`.replace(
      /\s+/g,
      " "
    );
  const format = `"${PRETTIER_BIN}" --write .`;

  return `${lintFix} ; ${format}`;
}

/**
 * The core (non-web) auto-fix command — same janitor as buildWebFix but uses the
 * bundled strict.eslint.config.mjs. Run BEFORE the gate each cycle so padding-line,
 * prefer-const, curly, etc. are squashed without model turns.
 */
export function buildCoreFix(): string {
  const lintFix =
    `"${ESLINT_BIN}" --no-config-lookup -c "${STRICT_CONFIG}" --fix .`.replace(
      /\s+/g,
      " "
    );
  const format = `"${PRETTIER_BIN}" --write .`;

  return `${lintFix} ; ${format}`;
}

/**
 * Auto-format ONE just-written file in place: `eslint --fix` (squashes the
 * auto-fixable mechanical rules — padding-line, curly, prefer-template, quotes)
 * then `prettier --write` (whitespace/quotes/width). Run at WRITE time (in the
 * write guard) so the model never sees — nor hand-chases — formatting noise.
 * Deferring all of this to the settle-time gate let the model self-run eslint
 * mid-build, see the un-squashed mechanical lint, and spiral fixing blank lines
 * and braces by hand to the turn cap. Best-effort + per-file (cheap): any failure
 * is swallowed and the settle gate stays the authority.
 */
export async function formatFile(cwd: string, file: string): Promise<void> {
  const abs = join(cwd, file);

  try {
    await Bun.spawn(
      [
        "bun",
        ESLINT_BIN,
        "--no-config-lookup",
        "-c",
        STRICT_CONFIG,
        "--fix",
        abs,
      ],
      { cwd, stdout: "ignore", stderr: "ignore" }
    ).exited;
  } catch {
    // best-effort — the settle gate still fixes + validates
  }

  try {
    await Bun.spawn(["bun", PRETTIER_BIN, "--write", abs], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  } catch {
    // best-effort
  }
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

/** The bundled `prettier --write` command. Prepended to the EVAL gate so the
 *  model's output is auto-formatted before the strict checks run — the model
 *  never burns turns hand-formatting, and the committed code is prettier-clean.
 *  Uses tsforge's own prettier so it works in a target with no prettier installed. */
export function prettierWriteCommand(): string {
  return `"${PRETTIER_BIN}" --write .`;
}

export async function buildGate(
  cwd: string,
  packs?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>,
  options?: { enableTypeAware?: boolean; includeTests?: boolean }
): Promise<IGate> {
  const parts: string[] = [];
  const labels: string[] = [];

  const tsc = await tscPart(cwd);

  if (tsc !== null) {
    parts.push(tsc);
    labels.push("tsc --strict");
  }

  const lint = lintPart(packs, ruleOverrides);

  parts.push(lint.command);
  labels.push(lint.label);

  if (options?.enableTypeAware === true) {
    const typeAware = await typeAwareLintPart(cwd);

    if (typeAware !== null) {
      parts.push(typeAware.command);
      labels.push(typeAware.label);
    }
  }

  // Tests run LAST (after the cheap static floor) so a type/lint error fails
  // fast without paying for a test run. Only appended when the project actually
  // has tests to run — a strict-floor-only run, or a project with none, skips it.
  if (options?.includeTests === true) {
    const test = await discoverTestCommand(cwd);

    if (test !== null) {
      parts.push(test);
      labels.push("tests");
    }
  }

  appendOptInOracles(parts, labels, process.env);

  return { command: parts.join(" && "), label: labels.join(" + ") };
}

/**
 * Opt-in quality oracles (default OFF, mirroring the web a11y/screenshot flags).
 * They run AFTER tests and read their own config from env, so the gate command
 * stays free of shell-quoting:
 *   - TSFORGE_COVERAGE=<pct> — fail if line coverage is below the floor.
 *   - TSFORGE_BOOT="<start cmd>" — boot the server and require a non-5xx response.
 *   - TSFORGE_PROPTEST=1 — fuzz exported functions from their types; fail if any
 *     throws on valid typed input.
 */
function appendOptInOracles(
  parts: string[],
  labels: string[],
  env: Record<string, string | undefined>
): void {
  if (env.TSFORGE_COVERAGE !== undefined && env.TSFORGE_COVERAGE.length > 0) {
    parts.push(`bun "${TEST_COVERAGE_CHECK}"`);
    labels.push("test coverage");
  }

  if (env.TSFORGE_BOOT !== undefined && env.TSFORGE_BOOT.trim().length > 0) {
    parts.push(`bun "${BOOT_CHECK}"`);
    labels.push("boot smoke");
  }

  if (env.TSFORGE_PROPTEST === "1") {
    parts.push(`bun "${PROPTEST_CHECK}"`);
    labels.push("property tests");
  }
}

/** The npm-init placeholder test script — running it always fails, so it must
 *  NOT count as "the project has tests". */
const PLACEHOLDER_TEST = /no test specified/i;

/**
 * The project's test command for the gate, or null when there's nothing to run.
 * Prefers an explicit, real package.json `test` script (run via `bun run test`);
 * else falls back to `bun test` when the project has test files; else null — so
 * a greenfield app with no tests yet stays at the strict floor instead of
 * failing a gate that runs a placeholder/absent test command.
 */
export async function discoverTestCommand(cwd: string): Promise<string | null> {
  const pkgFile = Bun.file(join(cwd, "package.json"));

  if (await pkgFile.exists()) {
    try {
      const pkg: unknown = await pkgFile.json();
      const scripts = isRecord(pkg) ? pkg.scripts : undefined;
      const script = isRecord(scripts) ? scripts.test : undefined;

      if (
        typeof script === "string" &&
        script.trim().length > 0 &&
        !PLACEHOLDER_TEST.test(script)
      ) {
        return "bun run test";
      }
    } catch {
      // Malformed package.json — fall through to file detection.
    }
  }

  return (await hasTestFiles(cwd)) ? "bun test" : null;
}

/** True when the project has at least one *.test.* / *.spec.* file (outside
 *  node_modules) — the signal that a bare `bun test` has something to run. */
async function hasTestFiles(cwd: string): Promise<boolean> {
  const glob = new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx}");

  for await (const path of glob.scan({ cwd, onlyFiles: true })) {
    if (!path.includes("node_modules")) {
      return true;
    }
  }

  return false;
}

/**
 * The type-aware floor — ALWAYS tsforge-strict (user policy: a repo's own config
 * is never trusted to be strict enough). With a project tsconfig, extend it under
 * `.tsforge/` but force the strict flags; greenfield, bring the full strict one.
 * null when not a TS project. (The strict overlay / bundled config win over
 * whatever the repo set.)
 */
async function tscPart(cwd: string): Promise<string | null> {
  const hasTsconfig = await Bun.file(join(cwd, "tsconfig.json")).exists();

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
    await Bun.write(join(cwd, "tsconfig.json"), STRICT_TSCONFIG);
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
  const entries = [GATE_TSCONFIG_FILE, GATE_TSBUILDINFO_FILE];
  const file = Bun.file(ignore);

  if (!(await file.exists())) {
    await Bun.write(ignore, `${entries.join("\n")}\n`);

    return;
  }

  // Exists (maybe a user's, or an older tsforge one without the buildinfo line):
  // append only the missing entries so we never clobber what's there.
  const current = await file.text();
  const missing = entries.filter((e) => !current.split("\n").includes(e));

  if (missing.length > 0) {
    await Bun.write(
      ignore,
      `${current.replace(/\n*$/u, "\n")}${missing.join("\n")}\n`
    );
  }
}

/** The syntactic idiom layer — ALWAYS tsforge's bundled strict eslint config
 *  (user policy). We deliberately do NOT defer to the project's own `lint`
 *  script: that's exactly how a weak repo would dodge the strict-TS floor. The
 *  bundled config needs no deps in the target. When packs are provided, they
 *  are passed via TSFORGE_PACKS env var so the config can load TS imports. Rule
 *  overrides are passed via TSFORGE_RULE_OVERRIDES (JSON-encoded map). */
function lintPart(
  packs?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>
): IGate {
  return {
    command: `${packEnvPrefix(packs, ruleOverrides)}bun "${ESLINT_BIN}" --no-config-lookup -c "${STRICT_CONFIG}" --format json .`,
    label: "strict TypeScript (tsforge)",
  };
}

/** Optional type-aware async rules — only when target has tsconfig.json. */
async function typeAwareLintPart(cwd: string): Promise<IGate | null> {
  const hasTsconfig = await Bun.file(join(cwd, "tsconfig.json")).exists();

  if (!hasTsconfig) {
    return null;
  }

  return {
    command: `bun "${ESLINT_BIN}" --no-config-lookup -c "${TYPE_AWARE_CONFIG}" --format json .`,
    label: "type-aware async (tsforge)",
  };
}
