import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ISweepReport } from "../eval";
import { overlayPathFor } from "./overlay";
import type { IHarnessOverlay } from "./self-harness.types";

/**
 * Whether a measured overlay is allowed into LIVE use — the campaign's only
 * write outside its own directory.
 *
 * This is a different instrument from the per-round acceptance rule, on
 * purpose. Acceptance asks "did this edit avoid regressing the splits the
 * proposer mined?", which is a low bar to clear by chance across many rounds on
 * a handful of tasks. Promotion asks the stricter question, on a split that is
 * never mined and measured at repeats=2: is this overlay's pass rate
 * distinguishable from the frozen baseline's?
 *
 * The paper stops at h_t and leaves deployment alone; this is the step that
 * decides whether h_t becomes the harness a human's own sessions run under.
 */

/** A candidate's own uncertainty must clear the baseline, not merely differ
 *  from it. The z-test alone accepts a tiny delta that is significant at large
 *  n; the interval alone accepts a wide, noisy one. Requiring both means the
 *  improvement survives its own error bars. */
export function promotionVerdict(report: ISweepReport): {
  promote: boolean;
  reason: string;
} {
  const baseline = report.variants.find((v) => v.label === report.baseline);
  const candidate = report.variants.find((v) => v.label !== report.baseline);

  if (baseline === undefined || candidate?.vsBaseline === undefined) {
    return { promote: false, reason: "proof produced no comparable pair" };
  }

  const { deltaPassRate, z, significant } = candidate.vsBaseline;
  const stats = describe(deltaPassRate, z, candidate.passRateCI);

  if (deltaPassRate <= 0) {
    return {
      promote: false,
      reason: `no uplift on the proof split (${stats})`,
    };
  }

  if (!significant) {
    return { promote: false, reason: `uplift not significant (${stats})` };
  }

  if (candidate.passRateCI[0] <= baseline.passRate) {
    return {
      promote: false,
      reason: `uplift does not survive its own interval (${stats}, baseline ${pct(baseline.passRate)})`,
    };
  }

  return { promote: true, reason: `significant uplift (${stats})` };
}

/**
 * Whether an already-installed overlay has become measurably WORSE than the
 * frozen baseline.
 *
 * Deliberately asymmetric with promotion: getting in requires surviving the
 * interval check, getting thrown out only requires a significant negative
 * delta. An unattended loop should be quicker to undo its own work than to
 * trust it.
 */
export function regressed(report: ISweepReport): {
  yes: boolean;
  reason: string;
} {
  const candidate = report.variants.find((v) => v.label !== report.baseline);

  if (candidate?.vsBaseline === undefined) {
    return { yes: false, reason: "" };
  }

  const { deltaPassRate, z, significant } = candidate.vsBaseline;

  return significant && deltaPassRate < 0
    ? { yes: true, reason: describe(deltaPassRate, z, candidate.passRateCI) }
    : { yes: false, reason: "" };
}

function pct(rate: number): string {
  return (rate * 100).toFixed(1);
}

function describe(
  delta: number,
  z: number,
  ci: readonly [number, number]
): string {
  return `Δ=${pct(delta)}pp z=${z.toFixed(2)} CI=[${pct(ci[0])}, ${pct(ci[1])}]`;
}

/**
 * Install an overlay for live use, keeping the displaced one as the rollback
 * point. Written to a temp file and renamed, so a session starting mid-write
 * can never read half an overlay — `activeOverlay()` reads this path
 * synchronously on a hot path with no locking.
 */
export async function installOverlay(
  modelId: string,
  overlay: IHarnessOverlay
): Promise<void> {
  const live = overlayPathFor(modelId);

  await mkdir(dirname(live), { recursive: true });

  if (existsSync(live)) {
    await Bun.write(previousPath(live), await Bun.file(live).text());
  }

  const tmp = `${live}.tmp`;

  await Bun.write(tmp, JSON.stringify(overlay, null, 2));
  await rename(tmp, live);
}

/**
 * Undo the last install. Returns false when there was no previous overlay to
 * restore, in which case the live one is removed outright — the base harness is
 * always a safe resting state, so a rollback never leaves a known-bad overlay
 * in place for want of something to replace it with.
 */
export async function revertOverlay(modelId: string): Promise<boolean> {
  const live = overlayPathFor(modelId);
  const prev = previousPath(live);

  if (existsSync(prev)) {
    await Bun.write(live, await Bun.file(prev).text());
    await rm(prev, { force: true });

    return true;
  }

  await rm(live, { force: true });

  return false;
}

export function previousPath(livePath: string): string {
  return `${livePath}.prev`;
}
