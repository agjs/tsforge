import { buildPackEslintConfig } from "../rule-packs";

/** The eslint flat-config block carrying the active packs' plugin + rules. */
export interface IPackConfigBlock {
  files: readonly string[];
  plugins: Record<string, unknown>;
  rules: Record<string, "error" | "warn">;
}

/** Pack ids handed to the spawned gate by `packEnvPrefix`. The one place that
 *  parses TSFORGE_PACKS — both bundled configs read it through here rather than
 *  each re-splitting the variable. */
export function envPackIds(): string[] {
  return (process.env.TSFORGE_PACKS ?? "").split(",").filter(Boolean);
}

/**
 * Build the rule-pack block for a BUNDLED gate config from the environment.
 *
 * The single source of truth for both bundled configs (core + web), which
 * previously each carried their own copy of this logic — and their own
 * `catch { /* continue without them *\/ }` around it.
 *
 * **Fail CLOSED.** A pack that cannot be resolved is an error, never a silently
 * dropped rule set. The old catch turned ONE unresolvable id into zero pack rules
 * for the entire gate while it still reported green, so a config typo — or any
 * configured external plugin, whose pack ids never resolve in this process —
 * silently disabled every framework rule.
 *
 * NOTE ON EXTERNAL PLUGINS. Plugin packs are registered in the orchestrator
 * process; this one starts with an empty registry, so a plugin's pack id is
 * unresolvable here and the gate now FAILS loudly instead of dropping everything.
 * That is deliberate: making it resolve would mean importing a module from a
 * workspace-controlled path into the gate process on every cycle, which is
 * arbitrary code execution inside the gate — a replaced plugin calling
 * `process.exit(0)` would make the lint stage report success without linting.
 * Supporting plugins in the gate needs content-freezing (a hash captured at
 * policy time and verified here, covering the module's transitive imports), which
 * is a design decision of its own. Until then: loud failure, never silent
 * weakening.
 */
export function buildEnvPackConfig(
  files: readonly string[],
  ruleOverrides: Readonly<Record<string, "error" | "warn" | "off">>
): IPackConfigBlock[] {
  const packIds = envPackIds();

  if (packIds.length === 0) {
    return [];
  }

  try {
    const { plugin, rules } = buildPackEslintConfig(packIds, ruleOverrides);

    return [{ files, plugins: { tsforge: plugin }, rules }];
  } catch (err) {
    // Re-throw with context, never swallow: this failure HARD-FAILS the gate, so
    // the operator has to see which pack and why without reading a stack trace.
    throw new Error(
      // Report the cause verbatim and nothing speculative: appending a blanket
      // "external plugins are unsupported" note to EVERY failure made a plain
      // typo read as a plugin problem.
      `tsforge gate: could not build the rule packs [${packIds.join(", ")}] — ${err instanceof Error ? err.message : String(err)}. Refusing to lint without them; fix the pack id in tsforge.config.json.`,
      { cause: err }
    );
  }
}
