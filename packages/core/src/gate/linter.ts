import { join, extname, resolve, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { ESLint } from "eslint";
import { runArgvCommand } from "../lib/fs/process";
import { conventionOverrideRules } from "../infer-rules/eslint-conventions";
import type { IConventions } from "../infer-rules/conventions.types";
import { trace } from "../lib/trace";
import { ESLINT_BIN, PRETTIER_BIN, STRICT_CONFIG } from "./tool-paths";
import type { FileLinter } from "./types";

/** Hard ceiling for the per-write formatters (eslint --fix / prettier --write) so a
 *  hung formatter can't wedge the write-guard hot path. Formatting one file is fast;
 *  30s is generous slack. */
const FORMAT_TIMEOUT_MS = 30_000;

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
  _framework: "core",
  cwd: string,
  packIds?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>,
  conventions?: IConventions
): FileLinter {
  const overrideConfigFile = STRICT_CONFIG;
  const ignores: string[] = [];
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

        // Conventions OVERRIDE the bundled config's naming/no-restricted-syntax in
        // process — so write-time feedback matches the gate (which gets the same
        // choice via TSFORGE_CONVENTIONS). A disabled rule is set "off" here, not
        // omitted, so it actually disables the bundled copy.
        if (conventions !== undefined) {
          const convConfig: Record<string, unknown> = {
            files: ["**/*.ts", "**/*.tsx"],
            rules: conventionOverrideRules(conventions, "core"),
          };

          eOpts.overrideConfig =
            eOpts.overrideConfig !== undefined
              ? [...eOpts.overrideConfig, convConfig]
              : [convConfig];
        }

        // Add pack rules if provided
        if (packIds !== undefined && packIds.length > 0) {
          const { buildPackEslintConfig } = await import("../rule-packs/index");

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
    } catch (err) {
      trace("makeFileLinter", err);

      return [];
    }
  };
}

/** Extensions the strict ESLint config actually has rules for. Handing eslint an
 *  explicit path outside this set (a `.json`/`.md`/`.css`) only makes it emit
 *  "File ignored" noise and burn the timeout parsing a file it can't lint — so the
 *  scoped fix filters its eslint targets to code files and lets prettier (with
 *  `--ignore-unknown`) handle everything else. */
const ESLINT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Canonical absolute path with symlinks resolved, or null if it does not exist
 *  (or can't be resolved). Used both to prove a target still exists and to make the
 *  containment check symlink-safe. */
async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/** From cwd-anchored candidates, keep the files that (a) still exist and (b) whose
 *  REAL path (symlinks resolved) is inside `realRoot` — then return each as a path
 *  RELATIVE to `cwd`. Relative is load-bearing: ESLint 10 flat config reports "File
 *  ignored because outside of base path" and applies ZERO fixes for an ABSOLUTE path,
 *  silently killing the autofix moat; a cwd-relative path fixes normally. The
 *  real-path containment stops an in-workspace symlink from redirecting a formatter at
 *  a file outside the workspace. */
async function containedRelTargets(
  cwd: string,
  realRoot: string,
  absCandidates: readonly string[]
): Promise<string[]> {
  const out: string[] = [];

  for (const abs of absCandidates) {
    const real = await realpathOrNull(abs);

    if (real === null) {
      continue;
    }

    if (real === realRoot || real.startsWith(realRoot + sep)) {
      out.push(relative(cwd, abs));
    }
  }

  return out;
}

/** Choose which prettier to run in `cwd`. When the target ships its OWN prettier
 *  (a local `node_modules/.bin/prettier`), run THAT binary: it carries the project's
 *  prettier VERSION and can resolve a shared/extended config that lives in the
 *  project's own `node_modules` (e.g. `"prettier": "@acme/prettier-config"`) — which
 *  tsforge's bundled prettier cannot see. So a file tsforge edits comes out formatted
 *  exactly as the project's own `prettier` / CI would format it, and an
 *  already-correct file is left byte-unchanged. Only when the project has no prettier
 *  of its own do we fall back to tsforge's bundled prettier, which still resolves a
 *  project `.prettierrc` if one exists and otherwise applies the tsforge default
 *  written by `bringConstitution`. */
export async function resolveProjectPrettierArgv(
  cwd: string
): Promise<string[]> {
  const binDir = join(cwd, "node_modules", ".bin");
  // On Windows npm writes `prettier.cmd` (the extensionless file is a POSIX shell
  // script cmd.exe can't spawn directly); everywhere else it's `prettier`. Prefer the
  // `.cmd` on win32 so the project binary is actually executable, else the fidelity
  // goal silently falls back to the bundled prettier.
  const candidates =
    process.platform === "win32"
      ? [join(binDir, "prettier.cmd"), join(binDir, "prettier")]
      : [join(binDir, "prettier")];

  for (const bin of candidates) {
    if (await Bun.file(bin).exists()) {
      return [bin];
    }
  }

  return ["bun", PRETTIER_BIN];
}

/**
 * Apply the strict eslint autofix + prettier to an EXPLICIT list of files — never
 * the whole tree. This is the scoping guarantee behind tsforge's formatting: it only
 * rewrites files it actually touched (each write via `formatFile`, and the
 * end-of-turn janitor over `ctx.tool.touched`), so running a build inside someone's
 * repo never reformats thousands of files it never edited. The file list is passed
 * in, so this is git-independent — it works the same in a fresh, non-git directory.
 *
 * Prettier defers to the project's own config and version (see
 * `resolveProjectPrettierArgv`); the eslint `--fix` keeps tsforge's strictness moat
 * (the `no-as` ban, `I`-prefix, …) on the files tsforge writes.
 *
 * Best-effort, like the rest of the format path: `runArgvCommand` never throws and a
 * non-zero exit / timeout is ignored — the settle gate stays the authority.
 */
export async function formatFiles(
  cwd: string,
  files: readonly string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<void> {
  const rels = [
    ...new Set(
      files.map((f) => f.replaceAll("\\", "/")).filter((f) => f.length > 0)
    ),
  ];

  if (rels.length === 0) {
    return;
  }

  // Containment guard: these argv reach mutating formatters directly, so a caller that
  // passes an absolute path, a `../` traversal, or an in-workspace symlink pointing
  // out must NOT be able to rewrite files outside the workspace. `containedRelTargets`
  // resolves symlinks, drops anything whose real path is outside cwd, and returns the
  // survivors RELATIVE to cwd (required — eslint no-ops on absolute paths).
  const realRoot = await realpathOrNull(resolve(cwd));

  if (realRoot === null) {
    return;
  }

  const present = await containedRelTargets(
    cwd,
    realRoot,
    rels.map((f) => resolve(cwd, f))
  );

  if (present.length === 0) {
    return;
  }

  const timeoutMs = opts.timeoutMs ?? FORMAT_TIMEOUT_MS;
  const signalOpt = opts.signal === undefined ? {} : { signal: opts.signal };

  // Route through the shared runner so a hung eslint/prettier is killed by the
  // timeout instead of wedging the caller (this runs inside the write-guard hot
  // path AND the end-of-turn janitor). Order mirrors the app pipeline: eslint --fix
  // first, prettier LAST, so prettier has the final say on formatting.
  const eslintTargets = present.filter((f) => ESLINT_EXTS.has(extname(f)));

  if (eslintTargets.length > 0) {
    await runArgvCommand(
      cwd,
      [
        "bun",
        ESLINT_BIN,
        "--no-config-lookup",
        "-c",
        STRICT_CONFIG,
        "--fix",
        ...eslintTargets,
      ],
      { timeoutMs, ...signalOpt }
    );
  }

  const prettierArgv = await resolveProjectPrettierArgv(cwd);

  await runArgvCommand(
    cwd,
    [...prettierArgv, "--write", "--ignore-unknown", ...present],
    { timeoutMs, ...signalOpt }
  );
}

/** Format a single file — the per-write path (write-guard). Thin wrapper over
 *  `formatFiles` so the per-write and janitor paths share one prettier-fidelity and
 *  eslint-moat implementation. */
export async function formatFile(cwd: string, file: string): Promise<void> {
  await formatFiles(cwd, [file]);
}

/** The bundled `prettier --write` command. Prepended to the EVAL gate so the
 *  model's output is auto-formatted before the strict checks run — the model
 *  never burns turns hand-formatting, and the committed code is prettier-clean.
 *  Uses tsforge's own prettier so it works in a target with no prettier installed. */
export function prettierWriteCommand(): string {
  return `"${PRETTIER_BIN}" --write .`;
}
