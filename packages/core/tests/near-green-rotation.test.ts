import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  injectFeedback,
  NEAR_GREEN_ROTATION_STEER,
  trackNearGreenRotation,
} from "../src/loop/turn";
import type { ILoopCtx, ILoopState } from "../src/loop/turn";
import { MAX_NEAR_GREEN_SPIKE_GAP } from "../src/loop/near-green-checkpoint";
import type { IErrorItem } from "../src/validate/validate.types";
import type { IValidateResult } from "../src/validate";
import type { IChatMessage } from "../src/inference";

// #77: the settleGate-level tracking that drives the near-green ROTATION steer. It accumulates
// the error-set signatures of near-green (1..N) cycles, IGNORES transient spikes above N (so the
// rotating near-green states accumulate across the regressions between them), and clears on green.

function freshState(): ILoopState {
  return {
    prevGateErrors: [],
    gateNoProgress: 0,
    bestErrorCount: Number.POSITIVE_INFINITY,
    noNewLow: 0,
    errorAge: new Map(),
    lastGateCount: -1,
    edits: 0,
    regressions: 0,
    ttsrInterrupts: 0,
    steerLevel: 0,
  };
}

const e = (rule: string, file: string): IErrorItem => ({
  key: `${file}:1:${rule}`,
  rule,
  file,
  message: rule,
});

test("rotating near-green error sets flip nearGreenRotation on after a full window", () => {
  const s = freshState();

  trackNearGreenRotation(s, 1, [e("jsx-computation", "Page.tsx")]);
  expect(s.nearGreenRotation).toBe(false); // 1 sig — not enough
  trackNearGreenRotation(s, 1, [e("component-folder-structure", "Row.tsx")]);
  expect(s.nearGreenRotation).toBe(false); // 2 sigs — still short of the window
  trackNearGreenRotation(s, 1, [e("no-unsafe-call", "queries.ts")]);
  expect(s.nearGreenRotation).toBe(true); // 3 DISTINCT near-green sigs → rotation
});

test("a genuinely stuck single error (same set repeated) is NOT rotation", () => {
  const s = freshState();

  for (let i = 0; i < 5; i++) {
    trackNearGreenRotation(s, 1, [e("no-jsx-computation", "Page.tsx")]);
  }

  expect(s.nearGreenRotation).toBe(false);
});

test("transient spikes above N are IGNORED — they don't reset the rotation window", () => {
  const s = freshState();

  // build17's real shape: near-green states interleaved with spikes to 3/6.
  trackNearGreenRotation(s, 1, [e("jsx-computation", "Page.tsx")]);
  trackNearGreenRotation(s, 6, [e("x", "a.ts"), e("y", "b.ts")]); // spike — ignored
  trackNearGreenRotation(s, 1, [e("missing-sibling", "Row.tsx")]);
  trackNearGreenRotation(s, 3, [e("z", "c.ts")]); // spike — ignored
  trackNearGreenRotation(s, 1, [e("no-unsafe-call", "queries.ts")]);

  // Three DISTINCT near-green sigs (all at the same count=1 plateau) accumulated across the
  // spikes → rotation.
  expect(s.nearGreenRotation).toBe(true);
  expect(s.nearGreenSamples?.length).toBe(3); // spikes were not pushed
});

test("a descent (2→1→1) is NOT rotation — a moving count is progress, not a plateau", () => {
  const s = freshState();

  // Same file/rule identity, but the COUNT changes 2→1→1. The count-blind version treated the
  // count-driven signature change as rotation (the panel's false positive); the count plateau
  // requirement rejects it.
  trackNearGreenRotation(s, 2, [e("a", "x.ts"), e("b", "y.ts")]);
  trackNearGreenRotation(s, 1, [e("a", "x.ts")]);
  trackNearGreenRotation(s, 1, [e("a", "x.ts")]);

  expect(s.nearGreenRotation).toBe(false);
});

test("a moving gate-frontier PHASE is progress, NOT rotation (short-circuit gate reveals the next phase)", () => {
  const s = freshState();

  const phased = (rule: string, file: string, phase: number): IErrorItem => ({
    key: `${file}:1:${rule}`,
    rule,
    file,
    message: rule,
    phase,
  });

  // Count stays at 1, but the frontier advances phase1 → phase2 (a downstream phase's error only
  // became visible after phase1 cleared). That is progress, so it must NOT read as rotation.
  trackNearGreenRotation(s, 1, [phased("a", "x.ts", 1)]);
  trackNearGreenRotation(s, 1, [phased("b", "y.ts", 2)]);
  trackNearGreenRotation(s, 1, [phased("b", "y.ts", 2)]);

  expect(s.nearGreenRotation).toBe(false);
});

test("completion-phase cycles are NOT recorded — the window can't pre-fill then fire post-completion", () => {
  const s = freshState();

  // While adding the missing UI (completion phase) the error identity legitimately churns. None of
  // it may accumulate toward rotation, else the flag would be set the instant completion ends.
  s.completionPhase = true;
  trackNearGreenRotation(s, 1, [e("reachability", "Page.tsx")]);
  trackNearGreenRotation(s, 1, [e("i18n-locale-keys-used", "Page.tsx")]);
  trackNearGreenRotation(s, 1, [e("no-unsafe-call", "queries.ts")]);

  expect(s.nearGreenRotation).toBe(false);
  expect(s.nearGreenSamples).toEqual([]);
});

test("kill-switch flipped ON mid-run CLEARS sticky rotation state (authoritative, not just early-return)", () => {
  const s = freshState();

  trackNearGreenRotation(s, 1, [e("a", "x.ts")]);
  trackNearGreenRotation(s, 1, [e("b", "y.ts")]);
  trackNearGreenRotation(s, 1, [e("c", "z.ts")]);
  expect(s.nearGreenRotation).toBe(true);

  process.env.TSFORGE_NO_NEAR_GREEN_ROTATION = "1";

  try {
    trackNearGreenRotation(s, 1, [e("d", "w.ts")]);
    // Disabled mid-run: the sticky flag is cleared, not left set — so injectFeedback stops.
    expect(s.nearGreenRotation).toBe(false);
    expect(s.nearGreenSamples).toEqual([]);
  } finally {
    delete process.env.TSFORGE_NO_NEAR_GREEN_ROTATION;
  }
});

test("green (curr 0) clears the window and the flag", () => {
  const s = freshState();

  trackNearGreenRotation(s, 1, [e("a", "x.ts")]);
  trackNearGreenRotation(s, 1, [e("b", "y.ts")]);
  trackNearGreenRotation(s, 1, [e("c", "z.ts")]);
  expect(s.nearGreenRotation).toBe(true);

  trackNearGreenRotation(s, 0, []);
  expect(s.nearGreenRotation).toBe(false);
  expect(s.nearGreenSamples).toEqual([]);
  expect(s.nearGreenSpikeGap).toBe(0);
});

// #77 — the USER-VISIBLE output: injectFeedback must prepend NEAR_GREEN_ROTATION_STEER only
// when the detector fired AND the current cycle is genuinely near green AND it's not the
// completion phase (which legitimately wants the model to ADD the missing UI, contradicting a
// "do not create new files" steer). These pin the three-condition gate the panel flagged as
// untested — a regression in the concatenation or the conditional would otherwise pass silently.

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))
  );
});

async function makeCtx(): Promise<{
  ctx: ILoopCtx;
  messages: IChatMessage[];
}> {
  const messages: IChatMessage[] = [];
  const cwd = await mkdtemp(join(tmpdir(), "tsforge-rotation-inj-"));

  dirs.push(cwd);

  const ctx: ILoopCtx = {
    task: { id: "t", intent: "test", accept: "", files: ["**/*"], context: [] },
    cwd,
    tsService: null,
    report: () => undefined,
    messages,
    tool: { touched: new Set<string>() },
    gate: {
      parse: undefined,
      runner: {
        run: async (): Promise<IValidateResult> => ({
          passed: true,
          errors: [],
          output: "",
        }),
      },
    },
  };

  return { ctx, messages };
}

test("injectFeedback PREPENDS the rotation steer when detector fired + near green + not completion", async () => {
  const { ctx, messages } = await makeCtx();
  const s = freshState();

  s.nearGreenRotation = true;

  await injectFeedback(ctx, s, [e("jsx-computation", "Page.tsx")], [], []);

  expect(messages).toHaveLength(1);
  expect(messages[0]?.content.startsWith(NEAR_GREEN_ROTATION_STEER)).toBe(true);
  // The near-green banner ("Do NOT create new files") is SUPPRESSED when the rotation steer fires
  // — else the model gets that flat prohibition stacked against the steer's "create the required
  // sibling/test files together in one edit", i.e. contradictory last-mile instructions.
  expect(messages[0]?.content.includes("NEAR-GREEN — only")).toBe(false);
});

test("injectFeedback SUPPRESSES the rotation steer on a spike above N (flag stays set, count too high)", async () => {
  const { ctx, messages } = await makeCtx();
  const s = freshState();

  s.nearGreenRotation = true;

  // 3 errors > NEAR_GREEN_N (2): the sticky flag is still true, but the "one or two errors from
  // done" wording doesn't hold at a spike, so it must NOT be injected.
  await injectFeedback(
    ctx,
    s,
    [e("a", "a.ts"), e("b", "b.ts"), e("c", "c.ts")],
    [],
    []
  );

  expect(messages).toHaveLength(1);
  expect(messages[0]?.content.includes(NEAR_GREEN_ROTATION_STEER)).toBe(false);
});

test("injectFeedback SUPPRESSES the rotation steer during the completion phase", async () => {
  const { ctx, messages } = await makeCtx();
  const s = freshState();

  s.nearGreenRotation = true;
  s.completionPhase = true;

  await injectFeedback(ctx, s, [e("reachability", "Page.tsx")], [], []);

  expect(messages).toHaveLength(1);
  expect(messages[0]?.content.includes(NEAR_GREEN_ROTATION_STEER)).toBe(false);
});

test("injectFeedback on a ROTATION SPIKE suppresses the undo/lockdown banner (no contradiction with the steer)", async () => {
  const { ctx, messages } = await makeCtx();
  const s = freshState();

  // Sticky rotation through the atomic-completion spike; best was 1 so a spike to 8 is a
  // regression from best. WS-B stands the rollback down for this spike — the banner must match
  // and NOT tell the model to undo it / not create files (that's build17's model-driven loop).
  s.nearGreenRotation = true;
  s.bestErrorCount = 1;

  await injectFeedback(
    ctx,
    s,
    Array.from({ length: 8 }, (_, i) => e(`r${String(i)}`, `f${String(i)}.ts`)),
    [],
    []
  );

  const content = messages[0]?.content ?? "";

  expect(content.includes("REGRESSION")).toBe(false);
  expect(content.includes("UNDO")).toBe(false);
  expect(content.includes("Do NOT create new files")).toBe(false);
  // The steer is near-green-only, so it's absent on the spike — the model just gets the errors.
  expect(content.includes(NEAR_GREEN_ROTATION_STEER)).toBe(false);
});

test("injectFeedback does NOT inject the rotation steer when the detector never fired", async () => {
  const { ctx, messages } = await makeCtx();
  const s = freshState();

  // nearGreenRotation unset — a normal near-green cycle with no rotation.
  await injectFeedback(ctx, s, [e("jsx-computation", "Page.tsx")], [], []);

  expect(messages).toHaveLength(1);
  expect(messages[0]?.content.includes(NEAR_GREEN_ROTATION_STEER)).toBe(false);
});

test("injectFeedback emit-path checks the flag: kill-switch OFF suppresses the steer even with sticky state set", async () => {
  const { ctx, messages } = await makeCtx();
  const s = freshState();

  // Sticky state left true (e.g. the detector fired before the kill-switch was flipped). The
  // emit-path flag check — not only the tracker's clear-on-disable — must stop the injection.
  s.nearGreenRotation = true;
  process.env.TSFORGE_NO_NEAR_GREEN_ROTATION = "1";

  try {
    await injectFeedback(ctx, s, [e("jsx-computation", "Page.tsx")], [], []);
    expect(messages[0]?.content.includes(NEAR_GREEN_ROTATION_STEER)).toBe(
      false
    );
  } finally {
    delete process.env.TSFORGE_NO_NEAR_GREEN_ROTATION;
  }
});

test("rotating at a near-green count above best: the steer leads and the banner is FULLY suppressed (no REGRESSION/UNDO/lockdown)", async () => {
  const { ctx, messages } = await makeCtx();
  const s = freshState();

  // Plateau at 2 (near green, ≤ N) above a best of 1 → rotation window AND a regression from best.
  // During rotation the model is in atomic-completion mode and WS-B has stood down, so the banner
  // is suppressed WHOLE — its "UNDO that collateral to get back to best" would tell the model to
  // undo the very completion the steer is asking for (build17's loop). The steer alone leads.
  s.nearGreenRotation = true;
  s.bestErrorCount = 1;

  await injectFeedback(ctx, s, [e("a", "x.ts"), e("b", "y.ts")], [], []);

  const content = messages[0]?.content ?? "";

  expect(content.startsWith(NEAR_GREEN_ROTATION_STEER)).toBe(true);
  expect(content.includes("REGRESSION")).toBe(false);
  expect(content.includes("UNDO")).toBe(false);
  expect(content.includes("NEAR-GREEN — only")).toBe(false);
});

test("near-green samples separated by more than the spike-gap bound do NOT combine into a false rotation", () => {
  const s = freshState();

  // Two near-green visits, then a LONG regression (more than MAX_NEAR_GREEN_SPIKE_GAP consecutive
  // spikes), then another near-green visit. The stale early samples must be dropped so a fresh,
  // unrelated near-green episode can't combine with them into a false rotation.
  trackNearGreenRotation(s, 1, [e("a", "x.ts")]);
  trackNearGreenRotation(s, 1, [e("b", "y.ts")]);

  for (let i = 0; i <= MAX_NEAR_GREEN_SPIKE_GAP; i++) {
    trackNearGreenRotation(s, 9, [e("spray", `s${String(i)}.ts`)]);
  }

  trackNearGreenRotation(s, 1, [e("c", "z.ts")]);

  // The window was cleared by the over-long spike run, so only the last sample survives → not a
  // full window → not rotation.
  expect(s.nearGreenRotation).toBe(false);
  expect(s.nearGreenSamples?.length).toBe(1);
});
