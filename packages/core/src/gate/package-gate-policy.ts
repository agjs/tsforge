import {
  loadTsforgeConfig,
  resolveActivePacks,
  normalizeRuleOverrides,
  resolveProjectProfile,
  withProfileOverride,
  type ITsforgeProjectConfig,
} from "../config/tsforge-config";
import type { ProfileId } from "../config/profiles";
import { resolveConventions } from "../infer-rules/conventions";
import type { IConventions } from "../infer-rules/conventions.types";
import { loadAndRegisterPlugins } from "../config/external-plugins";
import { detectStack } from "../stack-detection";
import { buildGate } from "./core-gate";
import { makeFileLinter } from "./linter";
import { discoverTestCommand } from "./test-discovery";
import type { FileLinter, IGateSpec } from "./types";

/**
 * Frozen per-package gate policy for workspace-container fan-out — mirrors
 * `captureGatePolicy` + monotonic packs in `cli/gate-setup.ts`.
 */
export interface IPackageGatePolicy {
  readonly dir: string;
  /** Frozen project config — never re-read mid-session (excludes can't drop packs). */
  readonly config: ITsforgeProjectConfig;
  readonly ruleOverrides: Record<string, "error" | "warn" | "off">;
  readonly profile: ProfileId;
  readonly conventions: IConventions;
  readonly baselinePacks: readonly string[];
  /** Discovered once; never re-read mid-session. */
  readonly testCommand: string | null;
  /** Monotonic pack accumulator for this package across cycles. */
  readonly activePacks: Set<string>;
}

/** Session-level CLI overlays applied when capturing each package policy. */
export interface IPackageGateCaptureOpts {
  readonly profile?: ProfileId;
  readonly strictFloorOnly?: boolean;
}

function overridesOrUndef(
  ruleOverrides: Record<string, "error" | "warn" | "off">
): Record<string, "error" | "warn" | "off"> | undefined {
  return Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined;
}

/** Capture frozen policy for one package root (once per session map entry). */
export async function capturePackageGatePolicy(
  pkgDir: string,
  opts: IPackageGateCaptureOpts = {}
): Promise<IPackageGatePolicy> {
  const config = withProfileOverride(
    await loadTsforgeConfig(pkgDir),
    opts.profile
  );
  const stack = await detectStack(pkgDir);
  const resolved = resolveActivePacks(stack.packs, config);
  // Child-declared external plugins — register once at capture (frozen thereafter).
  const externalPackIds =
    config.plugins === undefined
      ? []
      : await loadAndRegisterPlugins(config.plugins, pkgDir, () => undefined);
  const baselinePacks =
    externalPackIds.length > 0 ? [...resolved, ...externalPackIds] : resolved;

  return {
    dir: pkgDir,
    config,
    ruleOverrides: normalizeRuleOverrides(config),
    profile: resolveProjectProfile(config),
    conventions: resolveConventions(config.conventions),
    baselinePacks,
    testCommand:
      opts.strictFloorOnly === true ? null : await discoverTestCommand(pkgDir),
    activePacks: new Set(baselinePacks),
  };
}

/** Re-detect stack deps only; grow packs via the FROZEN config (monotonic). */
export async function resolvePackageGate(policy: IPackageGatePolicy): Promise<{
  readonly gate: IGateSpec;
  readonly packs: readonly string[];
  readonly lintFile: FileLinter;
}> {
  const stack = await detectStack(policy.dir);

  // Use frozen config — a mid-session packs.exclude edit must not drop packs.
  for (const pack of resolveActivePacks(stack.packs, policy.config)) {
    policy.activePacks.add(pack);
  }

  const packs = [...policy.activePacks].sort();
  const overrides = overridesOrUndef(policy.ruleOverrides);
  const gate = await buildGate(policy.dir, packs, overrides, {
    enableTypeAware: policy.profile === "strict",
    includeTests: policy.testCommand !== null,
    testCommand: policy.testCommand,
    conventions: policy.conventions,
  });

  return {
    gate,
    packs,
    lintFile: makeFileLinter(
      "core",
      policy.dir,
      packs,
      overrides,
      policy.conventions
    ),
  };
}
