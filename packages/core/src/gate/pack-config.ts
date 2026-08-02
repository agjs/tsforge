import { buildPackEslintConfig } from "../rule-packs";
import {
  loadAndRegisterPlugins,
  parsePlugins,
} from "../config/external-plugins";

/** The eslint flat-config block carrying the active packs' plugin + rules. */
export interface IPackConfigBlock {
  files: readonly string[];
  plugins: Record<string, unknown>;
  rules: Record<string, "error" | "warn">;
}

/** Pack ids handed to the spawned gate by `packEnvPrefix`. */
function envPackIds(): string[] {
  return (process.env.TSFORGE_PACKS ?? "").split(",").filter(Boolean);
}

/**
 * Build the rule-pack block for a BUNDLED gate config from the environment.
 *
 * The single source of truth for both bundled configs (core + web), which
 * previously each carried their own copy of this logic — and their own
 * `catch {}` around it.
 *
 * Two properties this must hold, both learned the hard way:
 *
 * 1. **Fail CLOSED.** A pack that cannot be resolved is an error, never a
 *    silently-dropped rule set. The old `catch { /* continue without them *\/ }`
 *    turned ONE bad id into zero pack rules for the whole gate, and the gate
 *    still reported green — a config typo silently disabled every framework rule.
 * 2. **Register external plugins first.** Plugin packs are registered in the
 *    orchestrator process, but the gate runs in a fresh one with an empty
 *    registry. Without re-registering here, every configured plugin's pack id is
 *    unresolvable — which, under the old catch, silently dropped ALL packs.
 *
 * KNOWN LIMITATION (tracked, deliberately not fixed here). Only the plugin
 * SPECS are frozen by the gate policy, not the plugin module's CONTENT: each
 * spawned gate re-imports the path, so a plugin file living inside the workspace
 * could be edited mid-session to weaken its own rules under the same pack id.
 * Freezing content needs a hash captured at policy time and verified here, and
 * an entry-file hash does not cover a plugin's transitive imports — a design
 * decision of its own. This is strictly better than the behavior it replaces
 * (where a configured plugin silently dropped EVERY pack, built-ins included),
 * but it is not yet the same guarantee as the frozen overrides/profile/test
 * command.
 */
export async function buildEnvPackConfig(
  files: readonly string[],
  ruleOverrides: Readonly<Record<string, "error" | "warn" | "off">>
): Promise<IPackConfigBlock[]> {
  const packIds = envPackIds();

  if (packIds.length === 0) {
    return [];
  }

  const raw = process.env.TSFORGE_PLUGINS;

  if (raw !== undefined && raw.length > 0) {
    // A malformed blob must not pass for "no plugins" — that would take us
    // straight back to unresolvable ids and a silently pack-less gate.
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        "tsforge gate: TSFORGE_PLUGINS is not valid JSON — refusing to lint without the packs it carries",
        { cause: err }
      );
    }

    await loadAndRegisterPlugins(parsePlugins(parsed), process.cwd(), (msg) => {
      process.stderr.write(`tsforge gate: ${msg}\n`);
    });
  }

  try {
    const { plugin, rules } = buildPackEslintConfig(packIds, ruleOverrides);

    return [{ files, plugins: { tsforge: plugin }, rules }];
  } catch (err) {
    // Re-throw with context, never swallow: this failure HARD-FAILS the gate, so
    // the operator has to see which pack and why without reading a stack trace.
    throw new Error(
      `tsforge gate: could not build the rule packs [${packIds.join(", ")}] — ${err instanceof Error ? err.message : String(err)}. Refusing to lint without them (fix the pack id in tsforge.config.json, or the plugin that should provide it).`,
      { cause: err }
    );
  }
}
