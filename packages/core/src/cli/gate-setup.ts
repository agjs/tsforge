/** Gate resolution for a CLI session: a resumed session's gate wins, then an
 *  explicit --accept, then --no-gate, else tsforge's auto strict-TS gate
 *  (with the per-write lint moat). */
import type { ICliArgs } from "./args";
import type { ISessionRecord } from "../session-store";
import { buildGate, makeFileLinter, type FileLinter } from "../gate";
import { BROWSER_CHECK } from "../gate/tool-paths";

function browserCheckCommand(htmlFile: string): string {
  return `bun "${BROWSER_CHECK}" "${htmlFile}"`;
}

/**
 * Resolve the session's gate + label. Starts from the base gate (resumed /
 * explicit / auto strict-TS), then appends a `--browser` render check when asked
 * — so a web build is verified to actually RUN, not just type-check.
 */
export async function resolveGate(
  args: ICliArgs,
  resumed: ISessionRecord | null
): Promise<{ accept: string; gateLabel: string; lintFile?: FileLinter }> {
  const base = await baseGate(args, resumed);

  if (args.browser.length === 0) {
    return base;
  }

  const browser = browserCheckCommand(args.browser);

  return {
    accept: base.accept.length > 0 ? `${base.accept} && ${browser}` : browser,
    gateLabel:
      base.accept.length > 0
        ? `${base.gateLabel} + browser render`
        : "browser render",
    ...(base.lintFile === undefined ? {} : { lintFile: base.lintFile }),
  };
}

/** The base gate: a resumed session's gate wins, then explicit `--accept`, then
 *  `--no-gate` (off), else tsforge's auto gate (strict-TS / project lint). */
async function baseGate(
  args: ICliArgs,
  resumed: ISessionRecord | null
): Promise<{ accept: string; gateLabel: string; lintFile?: FileLinter }> {
  if (resumed !== null) {
    const label = resumed.accept.length > 0 ? resumed.accept : "none";

    return { accept: resumed.accept, gateLabel: label };
  }

  if (args.accept.length > 0) {
    return { accept: args.accept, gateLabel: args.accept };
  }

  if (args.noGate) {
    return { accept: "", gateLabel: "none (--no-gate)" };
  }

  const { detectStack } = await import("../stack-detection");
  const {
    loadTsforgeConfig,
    resolveActivePacks,
    normalizeRuleOverrides,
    resolveProjectProfile,
    withProfileOverride,
  } = await import("../config/tsforge-config");
  const { resolveConventions } = await import("../infer-rules/conventions");
  const { resolveCliProfile } = await import("./args");

  const stackProfile = await detectStack(args.dir);
  const config = withProfileOverride(
    await loadTsforgeConfig(args.dir),
    resolveCliProfile(args.profile)
  );
  const activePacks = resolveActivePacks(stackProfile.packs, config);
  const ruleOverrides = normalizeRuleOverrides(config);
  const profile = resolveProjectProfile(config);
  const conventions = resolveConventions(config.conventions);

  const auto = await buildGate(
    args.dir,
    activePacks,
    Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
    {
      enableTypeAware: profile === "strict",
      // "Green" should mean the strict floor AND the project's own tests pass —
      // not just that it type-checks and lints. discoverTestCommand appends them
      // only when the project actually has tests; --strict-floor-only opts out.
      includeTests: !args.strictFloorOnly,
      conventions,
    }
  );

  return {
    accept: auto.command,
    gateLabel: auto.label,
    lintFile: makeFileLinter(
      "core",
      args.dir,
      activePacks,
      Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
      conventions
    ),
  };
}
