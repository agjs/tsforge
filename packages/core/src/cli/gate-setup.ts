/** Gate resolution for a CLI session: a resumed session's gate wins, then an
 *  explicit --accept, then --no-gate, else tsforge's auto strict-TS gate
 *  (with the per-write lint moat). */
import type { ICliArgs } from "./args";
import type { ISessionRecord, IGateFloor } from "../session-store";
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
  /** The frozen policy knobs (auto gate only) the caller persists as the resume FLOOR. The
   *  caller unions `packs` with the session's accumulated packs before persisting (so a
   *  `/clear` rebuild or a no-edit turn can't write back a weaker list), and stores the
   *  frozen `profile`/`ruleOverrides`/`testCommand` — so `--continue` resumes no weaker. */
  policy?: {
    profile: string;
    ruleOverrides: Record<string, "error" | "warn" | "off">;
    testCommand: string | null;
    packs: readonly string[];
  };
}

/** The FROZEN policy an auto gate runs under, captured ONCE at session start (or on
 *  `--continue`, which is a human re-invocation, not a mid-build cycle). The rule
 *  overrides, profile, conventions, and config all come from `tsforge.config.json`;
 *  freezing them means the code under test cannot relax its own gate by editing that
 *  file between cycles. Only the STACK (package.json dependencies) is re-read per cycle,
 *  and only ADDITIVELY (see the resolver's monotonic pack accumulator). */
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
  strictFloorOnly: boolean,
  floor?: IGateFloor
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

  // On resume the FLOOR profile wins — a `--continue --profile recommended` must not
  // downgrade a session floored as `strict` (which would drop the type-aware pass). Like
  // the restored accept/packs/overrides, the profile is part of the frozen session state;
  // changing it needs a fresh session. A fresh (non-resumed) run uses the CLI profile.
  const effectiveProfileArg = floor !== undefined ? floor.profile : profileArg;
  const config = withProfileOverride(
    await loadTsforgeConfig(dir),
    resolveCliProfile(effectiveProfileArg)
  );
  const stackProfile = await detectStack(dir);
  const freshPacks = resolveActivePacks(stackProfile.packs, config);
  const freshTest = strictFloorOnly ? null : await discoverTestCommand(dir);

  return {
    dir,
    config,
    // Keep the floor's frozen rule-severity overrides (never re-read a weaker set from a
    // config the subject may have edited between processes); else the fresh config's.
    ruleOverrides: floor?.ruleOverrides ?? normalizeRuleOverrides(config),
    profile: resolveProjectProfile(config),
    conventions: resolveConventions(config.conventions),
    // Union fresh detection ON TOP of the resume floor — a new framework is still picked
    // up, but a removed one can't drop the floor the last session reached.
    baselinePacks:
      floor === undefined
        ? freshPacks
        : Array.from(new Set([...floor.packs, ...freshPacks])).sort(),
    // Keep the floor's test command unless the project newly gained one (never drop it).
    testCommand:
      floor === undefined ? freshTest : (floor.testCommand ?? freshTest),
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
      // that it type-checks and lints. Run tests exactly when a command exists:
      // captureGatePolicy already nulls the test command under --strict-floor-only for a
      // fresh session, but a resume FLOOR's test command survives that flag (the session
      // established tests as part of green — a resume must not drop them).
      includeTests: policy.testCommand !== null,
      testCommand: policy.testCommand,
      conventions: policy.conventions,
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

/** Resolve the AUTO gate's command + baseline packs/overrides/conventions for `dir`.
 *  Captures the frozen policy and builds the gate for the packs detected right now.
 *  Used to seed the initial gate and by the greenfield re-detection test. */
export async function resolveAutoGate(
  dir: string,
  profileArg: string,
  strictFloorOnly: boolean
) {
  const policy = await captureGatePolicy(dir, profileArg, strictFloorOnly);
  const auto = await eslintFor(policy, policy.baselinePacks);

  return {
    command: auto.command,
    label: auto.label,
    activePacks: policy.baselinePacks,
    ruleOverrides: policy.ruleOverrides,
    conventions: policy.conventions,
  };
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

/** The auto gate: capture the frozen policy once (overlaying a resume `floor` when present
 *  so it resumes no weaker), seed the displayed label / persisted `accept` / per-write
 *  linter from the baseline packs, attach a resolver the Session refreshes each cycle, and
 *  expose the frozen knobs as `policy` for the caller to persist as the next floor. */
async function autoGateBranch(
  args: ICliArgs,
  floor?: IGateFloor
): Promise<IResolvedGate> {
  const policy = await captureGatePolicy(
    args.dir,
    args.profile,
    args.strictFloorOnly,
    floor
  );
  const initial = await eslintFor(policy, policy.baselinePacks);

  return {
    accept: initial.command,
    gateLabel: initial.label,
    autoGate: makeAutoGateResolver(policy),
    lintFile: lintFileFor(policy, policy.baselinePacks),
    policy: {
      profile: policy.profile,
      ruleOverrides: policy.ruleOverrides,
      testCommand: policy.testCommand,
      packs: policy.baselinePacks,
    },
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
  if (resumed !== null) {
    if (resumed.auto === true) {
      // Resume onto the persisted policy floor (union packs, restore profile, keep the
      // test command) so `--continue` can only get stricter, never weaker.
      return autoGateBranch(args, resumed.gatePolicy);
    }

    const label = resumed.accept.length > 0 ? resumed.accept : "none";

    return { accept: resumed.accept, gateLabel: label };
  }

  if (args.accept.length > 0) {
    return { accept: args.accept, gateLabel: args.accept };
  }

  if (args.noGate) {
    return { accept: "", gateLabel: "none (--no-gate)" };
  }

  return autoGateBranch(args);
}
