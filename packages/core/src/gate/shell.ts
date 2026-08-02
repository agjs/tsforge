import { conventionsEnvValue } from "../infer-rules/eslint-conventions";
import type { IConventions } from "../infer-rules/conventions.types";
import type { IExternalPlugin } from "../config/external-plugins";

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
export function packEnvPrefix(
  packs?: readonly string[],
  ruleOverrides?: Readonly<Record<string, "error" | "warn" | "off">>,
  conventions?: IConventions,
  plugins?: readonly IExternalPlugin[]
): string {
  const envParts: string[] = [];

  if (packs !== undefined && packs.length > 0) {
    envParts.push(`TSFORGE_PACKS=${shSingleQuote(packs.join(","))}`);
  }

  // External packs are registered in the ORCHESTRATOR process, but the gate runs
  // in a fresh one with an empty registry — so their ids arrived unresolvable and
  // the config dropped every pack. Hand the plugin specs over so the gate can
  // register them itself before building the pack config.
  if (plugins !== undefined && plugins.length > 0) {
    envParts.push(`TSFORGE_PLUGINS=${shSingleQuote(JSON.stringify(plugins))}`);
  }

  if (ruleOverrides !== undefined && Object.keys(ruleOverrides).length > 0) {
    envParts.push(
      `TSFORGE_RULE_OVERRIDES=${shSingleQuote(JSON.stringify(ruleOverrides))}`
    );
  }

  const conv = conventionsEnvValue(conventions);

  if (conv !== undefined) {
    envParts.push(`TSFORGE_CONVENTIONS=${shSingleQuote(conv)}`);
  }

  return envParts.length > 0 ? `${envParts.join(" ")} ` : "";
}
