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
 * Build the rule-pack block for a bundled gate config from the environment.
 * Shared by both bundled configs (core + web).
 *
 * Fails CLOSED: an unresolvable pack id throws rather than yielding a config with
 * no pack rules, which would lint green while enforcing nothing.
 *
 * External plugin packs do NOT resolve here — they are registered in the
 * orchestrator process and this one starts with an empty registry, so they hit
 * the same hard failure. That is deliberate: resolving them means importing a
 * workspace-controlled module into the gate subprocess every cycle, and a
 * replaced plugin calling `process.exit(0)` would make lint report success
 * without linting. Plugin content is frozen at load in the orchestrator
 * (`assertExternalPacksFrozen` / F19); write-time lint and the command gate
 * re-check the fingerprint before running. Shipping rule *implementations*
 * into this subprocess still needs a separate isolated channel.
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
