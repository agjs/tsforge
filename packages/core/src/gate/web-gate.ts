import { join } from "node:path";
import { existsSync } from "node:fs";
import { WEB_TEMPLATES, type WebFramework } from "../web-templates";
import type { IConventions } from "../infer-rules/conventions.types";
import type { IGate } from "./types";
import {
  ESLINT_BIN,
  TSC_BIN,
  PRETTIER_BIN,
  STRICT_WEB_CONFIG,
  TYPE_AWARE_CONFIG,
  BROWSER_CHECK,
  STUB_CHECK,
  STAGED_GATE,
} from "./tool-paths";
import { packEnvPrefix } from "./shell";
import { ensureWebGateTsconfig, PROJECT_TSCONFIG } from "./tsconfig";
import { webTestProbe } from "./test-discovery";

/** The frameworks the spec Q&A can scaffold. */
export const WEB_FRAMEWORKS: readonly WebFramework[] = ["react", "vanilla"];

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

/** The full web ladder: `vite build` + tsc strict + web eslint (vendored-exempt) +
 *  browser render of the built `dist/`. Build runs FIRST so any codegen (e.g.
 *  TanStack Router's routeTree.gen.ts) exists before tsc; `vite build` is itself
 *  the bundler oracle — it resolves imports, compiles JSX/Tailwind, fails on
 *  anything broken. */
export function buildWebGate(
  framework: WebFramework,
  packs: readonly string[] = WEB_PACKS,
  cwd: string = process.cwd(),
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>,
  conventions?: IConventions
): IGate {
  const template = WEB_TEMPLATES[framework];
  const ignores = template.eslintIgnore
    .map((glob) => `--ignore-pattern "${glob}"`)
    .join(" ");
  const build = `bun run build`;
  const tsc = `"${TSC_BIN}" --noEmit -p ${ensureWebGateTsconfig(cwd)}`;
  const lint =
    `${packEnvPrefix(packs, ruleOverrides, conventions)}bun "${ESLINT_BIN}" --no-config-lookup -c "${STRICT_WEB_CONFIG}" ${ignores} --format json .`.replace(
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
  // Type-aware lint uses `projectService` — every file it lints must be in the
  // tsconfig's program. The app tsconfig DELIBERATELY excludes `*.test.ts(x)` (so
  // tsc/the overlay don't choke on `bun:test`), so type-aware-linting a test file
  // makes the project service throw "not found by the project service — include it
  // in tsconfig.json" — which sends the model off to EDIT tsconfig (the exact rabbit
  // hole we fight elsewhere). Ignore test files here too, matching the tsconfig.
  const typeAwareIgnores = `${ignores} --ignore-pattern "**/*.test.ts" --ignore-pattern "**/*.test.tsx"`;
  const typeAware = existsSync(join(cwd, PROJECT_TSCONFIG))
    ? `bun "${ESLINT_BIN}" --no-config-lookup -c "${TYPE_AWARE_CONFIG}" ${typeAwareIgnores} --format json .`.replace(
        /\s+/g,
        " "
      )
    : null;
  // Run the project's bun tests when any exist. Test files use `bun:test` (a test
  // runtime, not part of the app build) — they're EXCLUDED from the app's tsconfig
  // so `tsc` doesn't choke on `bun:test`, and run here instead so a broken test
  // still fails the gate. The probe mirrors core `hasTestFiles` discovery (same
  // extensions, project-wide incl. a mirrored `tests/` dir) so a required test
  // isn't silently skipped; see `webTestProbe`.
  const tests = webTestProbe();

  // The SAME commands as the old `a && b && …` chain, run sequentially by the
  // staged-gate runner so a failure names its stage ("✗ typecheck FAILED") instead
  // of burying it in one opaque wall. Order is identical to the old chain, so the
  // stop-on-first-failure behaviour is unchanged; the type-aware lint is its own
  // stage (only when the scaffold has a tsconfig, as before).
  const stages = [
    { label: "vite build", command: build },
    { label: "typecheck", command: tsc },
    { label: "lint", command: lint },
    ...(typeAware === null
      ? []
      : [{ label: "type-aware lint", command: typeAware }]),
    { label: "stub check", command: stubs },
    { label: "format", command: format },
    { label: "tests", command: tests },
    { label: "browser smoke", command: render },
  ];
  const payload = Buffer.from(JSON.stringify(stages)).toString("base64");

  return {
    command: `bun "${STAGED_GATE}" ${payload}`,
    label: `${template.label} (build + tests + behaviour smoke)`,
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
  packs: readonly string[] = WEB_PACKS,
  cwd: string = process.cwd()
): IGate {
  const template = WEB_TEMPLATES[framework];
  const ignores = template.eslintIgnore
    .map((glob) => `--ignore-pattern "${glob}"`)
    .join(" ");
  // Same forced-test-exclude overlay as the full gate and the per-write check:
  // the DESIGN phase can have co-located `*.test.ts` siblings in scope, and any
  // rewrite of tsconfig.json (shadcn init, the model fixing a path) drops the
  // test-exclude — pulling them into `tsc` as `bun:test` TS2307s that nudge the
  // model into endlessly mangling tsconfig.json. Bypassing the overlay here was
  // the lone hole; see ensureWebGateTsconfig / buildWebTscCheck.
  const tsc = `"${TSC_BIN}" --noEmit -p ${ensureWebGateTsconfig(cwd)}`;
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
export function buildWebTscCheck(cwd: string = process.cwd()): string {
  // Same overlay as the gate: the per-write check runs WHILE the model is writing
  // test siblings, so without the forced test-exclude it would spuriously red every
  // edit with a `bun:test` TS2307 — the very thing that nudges the model into
  // mangling tsconfig.json in the first place.
  return `"${TSC_BIN}" --noEmit -p ${ensureWebGateTsconfig(cwd)}`;
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
