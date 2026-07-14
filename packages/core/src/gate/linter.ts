import { join } from "node:path";
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

  // Route through the shared runner so a hung eslint/prettier is killed by the
  // timeout instead of wedging this per-write path (it runs inside the write-guard).
  // runArgvCommand never throws and captures output, so this stays best-effort: a
  // non-zero exit or timeout is ignored — the settle gate is still the authority.
  await runArgvCommand(
    cwd,
    [
      "bun",
      ESLINT_BIN,
      "--no-config-lookup",
      "-c",
      STRICT_CONFIG,
      "--fix",
      abs,
    ],
    { timeoutMs: FORMAT_TIMEOUT_MS }
  );
  await runArgvCommand(cwd, ["bun", PRETTIER_BIN, "--write", abs], {
    timeoutMs: FORMAT_TIMEOUT_MS,
  });
}

/** The bundled `prettier --write` command. Prepended to the EVAL gate so the
 *  model's output is auto-formatted before the strict checks run — the model
 *  never burns turns hand-formatting, and the committed code is prettier-clean.
 *  Uses tsforge's own prettier so it works in a target with no prettier installed. */
export function prettierWriteCommand(): string {
  return `"${PRETTIER_BIN}" --write .`;
}
