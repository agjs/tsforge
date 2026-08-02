/** Gate resolution for a CLI session: a resumed session's gate wins, then an
 *  explicit --accept, then --no-gate, else tsforge's auto strict-TS gate
 *  (with the per-write lint moat). */
import type { ICliArgs } from "./args";
import type { ISessionRecord } from "../session-store";
import {
  buildGate,
  discoverTestCommand,
  makeFileLinter,
  type FileLinter,
} from "../gate";
import type { IStackProfile } from "../stack-detection";
import type { IConventions } from "../infer-rules/conventions.types";
import type { ITsforgeProjectConfig } from "../config/tsforge-config";
import type { ProfileId } from "../config/profiles";

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

/** The FROZEN policy an auto gate runs under, captured ONCE at session start (and afresh on
 *  each `--continue`, which is a human re-invocation that reflects the current project).
 *  WITHIN a running session the rule overrides, profile, conventions, and config are all
 *  frozen — the code under test can't relax its own gate by editing `tsforge.config.json`
 *  between cycles; only the STACK (package.json deps) is re-read per cycle, and only
 *  ADDITIVELY (the resolver's monotonic pack accumulator). */
interface IGatePolicy {
  dir: string;
  config: ITsforgeProjectConfig;
  ruleOverrides: Record<string, "error" | "warn" | "off">;
  profile: ProfileId;
  conventions: IConventions;
  /** The packs detected at capture time — the monotonic floor the gate never drops below. */
  baselinePacks: readonly string[];
  /** The project's test command discovered ONCE at capture (null when it has no tests /
   *  `--strict-floor-only`), then FROZEN for the session — never re-discovered per cycle.
   *  Re-discovering each cycle let the subject swap a real suite for a noop package script;
   *  freezing matches the pre-re-detection behavior. (The gate cannot force subject-authored
   *  tests to stay meaningful — a launcher like `bun run test` still reads the live
   *  `scripts.test`; that limitation is inherent and unchanged.) */
  testCommand: string | null;
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

/** Capture the frozen gate policy for `dir` ONCE: load config (+ CLI/recipe profile
 *  overlay), detect the current stack, and resolve the baseline packs, rule overrides,
 *  profile, and conventions. Everything here is read from the project tree exactly once
 *  per session so the subject can't relax the gate mid-build by rewriting config. */
async function captureGatePolicy(
  dir: string,
  profileArg: string,
  strictFloorOnly: boolean
): Promise<IGatePolicy> {
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

  const config = withProfileOverride(
    await loadTsforgeConfig(dir),
    resolveCliProfile(profileArg)
  );
  const stackProfile = await detectStack(dir);

  return {
    dir,
    config,
    ruleOverrides: normalizeRuleOverrides(config),
    profile: resolveProjectProfile(config),
    conventions: resolveConventions(config.conventions),
    baselinePacks: resolveActivePacks(stackProfile.packs, config),
    // Discover the test command ONCE and freeze it — see IGatePolicy.testCommand.
    testCommand: strictFloorOnly ? null : await discoverTestCommand(dir),
  };
}

function overridesOrUndef(
  ruleOverrides: Record<string, "error" | "warn" | "off">
): Record<string, "error" | "warn" | "off"> | undefined {
  return Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined;
}

/** Build the eslint gate command + label for a fixed pack-set under a frozen policy. Uses
 *  the policy's FROZEN test command (captured once) so a cycle can't re-discover a weaker
 *  one — buildGate is told the command explicitly and never re-reads the project. */
async function eslintFor(
  policy: IGatePolicy,
  activePacks: readonly string[]
): Promise<{ command: string; label: string }> {
  const auto = await buildGate(
    policy.dir,
    activePacks,
    overridesOrUndef(policy.ruleOverrides),
    {
      enableTypeAware: policy.profile === "strict",
      // "Green" should mean the strict floor AND the project's own tests pass — not just
      // that it type-checks and lints. Run tests exactly when a (frozen) command exists;
      // captureGatePolicy nulls it under --strict-floor-only or when the project has none.
      includeTests: policy.testCommand !== null,
      testCommand: policy.testCommand,
      conventions: policy.conventions,
      // Hand the plugin specs to the spawned gate: it registers external packs in
      // its OWN process, so without these their ids don't resolve there.
      ...(policy.config.plugins === undefined
        ? {}
        : { plugins: policy.config.plugins }),
    }
  );

  return { command: auto.command, label: auto.label };
}

/** Build the per-write lint moat for a pack-set under a frozen policy. */
function lintFileFor(
  policy: IGatePolicy,
  activePacks: readonly string[]
): FileLinter {
  return makeFileLinter(
    "core",
    policy.dir,
    activePacks,
    overridesOrUndef(policy.ruleOverrides),
    policy.conventions
  );
}

/** A resolver the Session runs before each auto-gate cycle. Re-detects the stack and
 *  hands back the fresh eslint command, stack profile, and per-write linter, so a
 *  greenfield build stops being linted as `generic-ts` once its package.json lists a
 *  framework. MONOTONIC: packs only ever accumulate — a pack the session (or a prior
 *  cycle) activated is never dropped, so the subject can make the gate stricter by
 *  adding a framework but can NEVER relax it by deleting a dependency. Rule overrides,
 *  profile, conventions, and the test command stay frozen (captured once) for the same
 *  reason — re-discovering the test command each cycle let a real suite be swapped for a
 *  noop package script. */
function makeAutoGateResolver(policy: IGatePolicy): AutoGateResolver {
  const activePacks = new Set<string>(policy.baselinePacks);

  return async () => {
    const { detectStack } = await import("../stack-detection");
    const { resolveActivePacks } = await import("../config/tsforge-config");

    const stack = await detectStack(policy.dir);

    for (const pack of resolveActivePacks(stack.packs, policy.config)) {
      activePacks.add(pack);
    }

    const packs = Array.from(activePacks).sort();
    const auto = await eslintFor(policy, packs);

    return {
      command: auto.command,
      // The effective packs the gate/linter run — carried as the stack profile so a
      // refresh updates the change-scoped meta-rules and per-write moat too.
      stackProfile: { ...stack, packs },
      lintFile: lintFileFor(policy, packs),
    };
  };
}

/** The auto gate: capture the frozen policy once, seed the displayed label / persisted
 *  `accept` / per-write linter from the baseline packs, and attach a resolver the Session
 *  refreshes each cycle. */
async function autoGateBranch(args: ICliArgs): Promise<IResolvedGate> {
  const policy = await captureGatePolicy(
    args.dir,
    args.profile,
    args.strictFloorOnly
  );
  const initial = await eslintFor(policy, policy.baselinePacks);

  return {
    accept: initial.command,
    gateLabel: initial.label,
    autoGate: makeAutoGateResolver(policy),
    lintFile: lintFileFor(policy, policy.baselinePacks),
  };
}

/** The base gate: a resumed session's gate wins, then explicit `--accept`, then
 *  `--no-gate` (off), else tsforge's auto gate. A resumed AUTO session (persisted
 *  `auto: true`) re-attaches the resolver so `--continue` keeps re-detecting the stack;
 *  a resumed manual/off session keeps its stored gate verbatim (no re-detection, and an
 *  empty stored accept stays OFF — resuming after `--no-gate` never silently re-arms). */
async function baseGate(
  args: ICliArgs,
  resumed: ISessionRecord | null
): Promise<IResolvedGate> {
  // An explicit THIS-run override always wins — even on `--continue`. Checked BEFORE the
  // resumed record so `tsforge --continue --accept "..."` uses that command and
  // `--continue --no-gate` actually turns the gate off (not a silent auto re-arm).
  if (args.accept.length > 0) {
    return { accept: args.accept, gateLabel: args.accept };
  }

  if (args.noGate) {
    return { accept: "", gateLabel: "none (--no-gate)" };
  }

  if (resumed !== null) {
    if (resumed.auto === true) {
      // A resumed AUTO session re-attaches the resolver and re-detects from the CURRENT
      // project (a `--continue` is a fresh human invocation). The within-session freeze +
      // monotonic packs still hold for the drive that follows.
      return autoGateBranch(args);
    }

    const label = resumed.accept.length > 0 ? resumed.accept : "none";

    return { accept: resumed.accept, gateLabel: label };
  }

  return autoGateBranch(args);
}
