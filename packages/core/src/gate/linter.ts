import { join, extname, resolve, relative, dirname, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { ESLint } from "eslint";
import { runArgvCommand } from "../lib/fs/process";
import { conventionOverrideRules } from "../infer-rules/eslint-conventions";
import type { IConventions } from "../infer-rules/conventions.types";
import { trace } from "../lib/trace";
import { isWin32 } from "../lib/platform";
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
const ESLINT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

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

/** True if `p` is a regular file. Directories must never reach the formatters:
 *  `prettier --write <dir>` expands to the whole subtree, reintroducing the
 *  whole-repo rewrite this module exists to prevent. */
async function isRegularFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** From cwd-anchored candidates, keep the ones that (a) exist, (b) are a regular FILE
 *  (never a directory), and (c) whose REAL path (symlinks resolved) is inside
 *  `realRoot` — then return each RELATIVE TO `realRoot`. Two things are load-bearing:
 *
 *  - RELATIVE, not absolute: ESLint 10 flat config reports "File ignored because
 *    outside of base path" and applies ZERO fixes for an absolute path, silently
 *    killing the autofix moat; a relative path fixes normally.
 *  - relative to the REAL root, not the caller's `cwd`: on macOS `cwd` can be the
 *    logical `/var/…` form while a resolved input is `/private/var/…`; relativizing
 *    against the unresolved forms yields a `../../private/var/…` path ESLint again
 *    treats as outside-base. Both sides realpath'd, the relative path is clean.
 *
 *  The real-path containment also stops an in-workspace symlink from redirecting a
 *  formatter at a file outside the workspace. */
async function containedRelTargets(
  realRoot: string,
  absCandidates: readonly string[]
): Promise<string[]> {
  const out: string[] = [];

  for (const abs of absCandidates) {
    const real = await realpathOrNull(abs);

    if (real === null || !(await isRegularFile(real))) {
      continue;
    }

    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      continue;
    }

    const rel = relative(realRoot, real);

    // Empty (the root itself) or escaping (`..` / `../…`) can't happen for a contained
    // regular file, but guard anyway — an empty arg to prettier expands to the whole
    // tree. NB: match only a real parent ref, not a filename that merely starts with
    // two dots (e.g. `..draft.ts`), which is a legitimate contained file.
    if (rel.length === 0 || rel === ".." || rel.startsWith(".." + sep)) {
      continue;
    }

    out.push(rel);
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
  // POSIX only. `node_modules/.bin/prettier` is a directly-spawnable shell script here;
  // on Windows the runnable entry is `prettier.cmd`, which the shell-less runner can't
  // spawn — so on win32 we always use the bundled prettier (spawned via `bun`), which
  // still resolves a project `.prettierrc`. Preferring the project binary is a POSIX
  // fidelity win, not a correctness requirement.
  if (!isWin32()) {
    // Walk up from cwd like Node's module resolution: in a monorepo a package subdir may
    // have prettier hoisted to the workspace root's node_modules. At each level trust the
    // bin only when prettier is actually INSTALLED as a package there (its manifest
    // exists) — not a lone `.bin/prettier` shim someone dropped in. tsforge already runs
    // the project's own scripts/binaries in the gate, so this is the same "only point
    // tsforge at repos you trust" boundary, narrowed to "prettier is a real dependency".
    let dir = resolve(cwd);

    for (;;) {
      const projectBin = join(dir, "node_modules", ".bin", "prettier");
      const manifest = join(dir, "node_modules", "prettier", "package.json");

      if (
        (await Bun.file(projectBin).exists()) &&
        (await Bun.file(manifest).exists())
      ) {
        return [projectBin];
      }

      const parent = dirname(dir);

      if (parent === dir) {
        break;
      }

      dir = parent;
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
  // Do NOT normalize separators. On POSIX a backslash is a legal filename character, so
  // rewriting `dir\file.ts` → `dir/file.ts` would retarget a different, untouched file.
  // But we also can't safely resolve such a path: macOS `realpath("…/a\b.ts")` itself
  // normalizes the backslash and returns `…/a/b.ts`. So on POSIX, DROP any input path
  // containing a backslash up front — before resolve/realpath can retarget it. Real
  // touched paths are already forward-slashed (recordTouched), so this only guards a
  // pathological input.
  const rels = [...new Set(files.filter((f) => f.length > 0))].filter(
    (f) => isWin32() || !f.includes("\\")
  );

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
        // `--` terminates options: a contained file literally named like a flag
        // (e.g. `--config=x.js`) is then treated as a path, never an option — so it
        // can't alter the formatter or make it load repo-controlled config.
        "--",
        ...eslintTargets,
      ],
      { timeoutMs, ...signalOpt }
    );
  }

  const prettierArgv = await resolveProjectPrettierArgv(cwd);

  await runArgvCommand(
    cwd,
    [...prettierArgv, "--write", "--ignore-unknown", "--", ...present],
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
