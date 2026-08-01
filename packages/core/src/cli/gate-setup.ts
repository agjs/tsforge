/** Gate resolution for a CLI session: a resumed session's gate wins, then an
 *  explicit --accept, then --no-gate, else tsforge's auto strict-TS gate
 *  (with the per-write lint moat). */
import type { ICliArgs } from "./args";
import type { ISessionRecord } from "../session-store";
import { buildGate, makeFileLinter, type FileLinter } from "../gate";
import type { IStackProfile } from "../stack-detection";
import type { IConventions } from "../infer-rules/conventions.types";

/** A re-resolution of the AUTO gate for the CURRENT project state. The Session calls
 *  this before each gate cycle (while the auto gate is active) so a greenfield build
 *  picks up framework rule-packs the moment its package.json lists them — instead of
 *  being frozen on the empty-dir `generic-ts` fallback captured at session start. */
export type AutoGateResolver = () => Promise<{
  command: string;
  stackProfile: IStackProfile;
  lintFile?: FileLinter;
}>;

export interface IResolvedGate {
  accept: string;
  gateLabel: string;
  lintFile?: FileLinter;
  /** Present ONLY for the auto gate. The Session refreshes `task.accept` (+ the stack
   *  profile and per-write linter) from this each cycle, and stops the moment the user
   *  overrides the gate (`/gate`, a recipe). Absent for explicit/`--no-gate` gates. */
  autoGate?: AutoGateResolver;
}

/**
 * Resolve the session's gate + label. Returns the base gate (resumed /
 * explicit / auto strict-TS).
 */
export async function resolveGate(
  args: ICliArgs,
  resumed: ISessionRecord | null
): Promise<IResolvedGate> {
  return baseGate(args, resumed);
}

/** Resolve the AUTO gate's command + active packs/overrides/conventions for `dir`.
 *  Runs stack detection FRESH each call so callers (initial setup AND the per-cycle
 *  dynamic gate) always reflect the CURRENT package.json — the fix for greenfield
 *  builds that start empty and add a framework mid-build. */
export async function resolveAutoGate(
  dir: string,
  profileArg: string,
  strictFloorOnly: boolean
) {
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

  const stackProfile = await detectStack(dir);
  const config = withProfileOverride(
    await loadTsforgeConfig(dir),
    resolveCliProfile(profileArg)
  );
  const activePacks = resolveActivePacks(stackProfile.packs, config);
  const ruleOverrides = normalizeRuleOverrides(config);
  const profile = resolveProjectProfile(config);
  const conventions = resolveConventions(config.conventions);

  const auto = await buildGate(
    dir,
    activePacks,
    Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
    {
      enableTypeAware: profile === "strict",
      // "Green" should mean the strict floor AND the project's own tests pass —
      // not just that it type-checks and lints. discoverTestCommand appends them
      // only when the project actually has tests; --strict-floor-only opts out.
      includeTests: !strictFloorOnly,
      conventions,
    }
  );

  return {
    command: auto.command,
    label: auto.label,
    // The effective packs the gate/linter run — detected framework packs PLUS profile
    // extras + external plugins. Carried as the stack profile so a refresh updates the
    // change-scoped meta-rules and per-write moat too, not just the eslint command.
    stackProfile: { ...stackProfile, packs: activePacks },
    activePacks,
    ruleOverrides,
    conventions,
  };
}

/** Build the per-write lint moat for the CURRENT active packs/overrides/conventions. */
function lintFileFor(
  dir: string,
  activePacks: readonly string[],
  ruleOverrides: Record<string, "error" | "warn" | "off">,
  conventions: IConventions
): FileLinter {
  return makeFileLinter(
    "core",
    dir,
    activePacks,
    Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined,
    conventions
  );
}

/** A resolver the Session runs before each auto-gate cycle: re-detect the stack and
 *  hand back the fresh eslint command, stack profile, and per-write linter, so a
 *  greenfield build stops being linted as `generic-ts` once its package.json lists a
 *  framework. Honors user overrides in the Session, which stops calling this once the
 *  user sets a manual gate. */
function makeAutoGateResolver(
  dir: string,
  profileArg: string,
  strictFloorOnly: boolean
): AutoGateResolver {
  return async () => {
    const r = await resolveAutoGate(dir, profileArg, strictFloorOnly);

    return {
      command: r.command,
      stackProfile: r.stackProfile,
      lintFile: lintFileFor(dir, r.activePacks, r.ruleOverrides, r.conventions),
    };
  };
}

/** The base gate: a resumed session's gate wins, then explicit `--accept`, then
 *  `--no-gate` (off), else tsforge's auto gate (strict-TS / project lint). The auto gate
 *  (fresh OR a resumed session that had no explicit `--accept`) carries an `autoGate`
 *  resolver so the Session re-detects the stack every cycle. */
async function baseGate(
  args: ICliArgs,
  resumed: ISessionRecord | null
): Promise<IResolvedGate> {
  // An explicit --accept or --no-gate is a manual gate — no auto re-detection.
  if (args.accept.length > 0) {
    return { accept: args.accept, gateLabel: args.accept };
  }

  if (args.noGate) {
    return { accept: "", gateLabel: "none (--no-gate)" };
  }

  // A resumed session with a stored explicit gate command keeps it (no re-detection);
  // one resumed WITHOUT an explicit accept is an auto session — fall through so it gets
  // the resolver again (fixes --continue freezing a greenfield build on generic-ts).
  if (resumed !== null && resumed.accept.length > 0) {
    return { accept: resumed.accept, gateLabel: resumed.accept };
  }

  const autoGate = makeAutoGateResolver(
    args.dir,
    args.profile,
    args.strictFloorOnly
  );
  // Initial resolution seeds the displayed label, the persisted `accept`, and the
  // per-write linter; the Session refreshes all three from `autoGate` each cycle.
  const initial = await resolveAutoGate(
    args.dir,
    args.profile,
    args.strictFloorOnly
  );

  return {
    accept: initial.command,
    gateLabel: initial.label,
    autoGate,
    lintFile: lintFileFor(
      args.dir,
      initial.activePacks,
      initial.ruleOverrides,
      initial.conventions
    ),
  };
}
