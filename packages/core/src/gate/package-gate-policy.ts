import {
  loadTsforgeConfig,
  resolveActivePacks,
  normalizeRuleOverrides,
  resolveProjectProfile,
} from "../config/tsforge-config";
import { resolveConventions } from "../infer-rules/conventions";
import type { IConventions } from "../infer-rules/conventions.types";
import { detectStack } from "../stack-detection";
import { buildGate } from "./core-gate";
import { makeFileLinter } from "./linter";
import { discoverTestCommand } from "./test-discovery";
import type { FileLinter, IGateSpec } from "./types";

/**
 * Frozen per-package gate policy for workspace-container fan-out — mirrors
 * `captureGatePolicy` + monotonic packs in `cli/gate-setup.ts`, but without
 * CLI profile flags (each package's own tsforge.config.json wins via upward
 * walk from that package).
 */
export interface IPackageGatePolicy {
  readonly dir: string;
  readonly ruleOverrides: Record<string, "error" | "warn" | "off">;
  readonly profile: ReturnType<typeof resolveProjectProfile>;
  readonly conventions: IConventions;
  readonly baselinePacks: readonly string[];
  /** Discovered once; never re-read mid-session. */
  readonly testCommand: string | null;
  /** Monotonic pack accumulator for this package across cycles. */
  readonly activePacks: Set<string>;
}

function overridesOrUndef(
  ruleOverrides: Record<string, "error" | "warn" | "off">
): Record<string, "error" | "warn" | "off"> | undefined {
  return Object.keys(ruleOverrides).length > 0 ? ruleOverrides : undefined;
}

/** Capture frozen policy for one package root (once per session map entry). */
export async function capturePackageGatePolicy(
  pkgDir: string
): Promise<IPackageGatePolicy> {
  const config = await loadTsforgeConfig(pkgDir);
  const stack = await detectStack(pkgDir);
  const baselinePacks = resolveActivePacks(stack.packs, config);

  return {
    dir: pkgDir,
    ruleOverrides: normalizeRuleOverrides(config),
    profile: resolveProjectProfile(config),
    conventions: resolveConventions(config.conventions),
    baselinePacks,
    testCommand: await discoverTestCommand(pkgDir),
    activePacks: new Set(baselinePacks),
  };
}

/** Re-detect stack, grow packs monotonically, build the gate command. */
export async function resolvePackageGate(policy: IPackageGatePolicy): Promise<{
  readonly gate: IGateSpec;
  readonly packs: readonly string[];
  readonly lintFile: FileLinter;
}> {
  const config = await loadTsforgeConfig(policy.dir);
  const stack = await detectStack(policy.dir);

  for (const pack of resolveActivePacks(stack.packs, config)) {
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
