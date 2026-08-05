/**
 * Acceptance-rule unit tests + a deterministic end-to-end run of the full
 * Self-Harness loop with a scripted proposer and a programmed fake evaluator
 * — Algorithm 1's control flow proven without a live model.
 */
import { test, expect, describe } from "bun:test";
import {
  acceptanceDecision,
  validateCandidate,
  type HarnessEvaluator,
} from "../src/self-harness/validate";
import { runSelfHarness } from "../src/self-harness/loop";
import { emitReport } from "../src/self-harness/report";
import { emptyOverlay } from "../src/self-harness/overlay";
import type {
  ICandidate,
  IHarnessEval,
  ISplitScore,
  ISplits,
} from "../src/self-harness/self-harness.types";
import type { IMinedRun } from "../src/self-harness/mine";
import type { IChatMessage, IModelResponse, IProvider } from "../src/inference";
import type { ILoopEvent } from "../src/loop/loop.types";

function score(partial: Partial<ISplitScore>): ISplitScore {
  return {
    passed: 0,
    runs: 8,
    errored: 0,
    avgQuality: 0,
    avgLoc: 0,
    perTask: {},
    ...partial,
  };
}

function evalOf(
  heldIn: Partial<ISplitScore>,
  heldOut: Partial<ISplitScore>
): IHarnessEval {
  return { heldIn: score(heldIn), heldOut: score({ runs: 4, ...heldOut }) };
}

describe("acceptanceDecision — the paper's rule, exactly", () => {
  const baseline = evalOf({ passed: 4 }, { passed: 2 });

  test("accepts strict gain on one split with no regression on the other", () => {
    const d = acceptanceDecision(
      baseline,
      evalOf({ passed: 5 }, { passed: 2 })
    );

    expect(d.accepted).toBe(true);
    expect(d.deltaIn).toBe(1);
    expect(d.deltaOut).toBe(0);
  });

  test("rejects Δin=0 ∧ Δho=0 (no strict gain)", () => {
    const d = acceptanceDecision(
      baseline,
      evalOf({ passed: 4 }, { passed: 2 })
    );

    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("no strict gain");
  });

  test("rejects any regression, even when the total improves", () => {
    // +3 held-in, -1 held-out: total is up, but the rule is conservative
    const d = acceptanceDecision(
      baseline,
      evalOf({ passed: 7 }, { passed: 1 })
    );

    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("held-out");
  });

  test("quality guard: pass-rate gain bought with worse held-out quality is rejected", () => {
    const withQuality = evalOf({ passed: 4 }, { passed: 2, avgQuality: 4.0 });
    const d = acceptanceDecision(
      withQuality,
      evalOf({ passed: 6 }, { passed: 2, avgQuality: 3.0 })
    );

    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("quality regressed");

    // within tolerance (0.5) → accepted
    const ok = acceptanceDecision(
      withQuality,
      evalOf({ passed: 6 }, { passed: 2, avgQuality: 3.6 })
    );

    expect(ok.accepted).toBe(true);
  });

  test("quality guard is skipped when either side lacks a judge signal", () => {
    const noSignal = acceptanceDecision(
      evalOf({ passed: 4 }, { passed: 2, avgQuality: 0 }),
      evalOf({ passed: 6 }, { passed: 2, avgQuality: 1.0 })
    );

    expect(noSignal.accepted).toBe(true);
  });

  test("concision guard: held-out solutions ballooning past 1.25× is rejected", () => {
    const d = acceptanceDecision(
      evalOf({ passed: 4 }, { passed: 2, avgLoc: 100 }),
      evalOf({ passed: 6 }, { passed: 2, avgLoc: 130 })
    );

    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("concision guard");
  });
});

/** A split score carrying a graded progress figure. */
function withProgress(
  base: IHarnessEval,
  heldIn: number | undefined,
  heldOut: number | undefined
): IHarnessEval {
  return {
    heldIn: {
      ...base.heldIn,
      ...(heldIn === undefined ? {} : { avgProgress: heldIn }),
    },
    heldOut: {
      ...base.heldOut,
      ...(heldOut === undefined ? {} : { avgProgress: heldOut }),
    },
  };
}

describe("acceptanceDecision — graded progress (Δin=0 ∧ Δho=0)", () => {
  const passes = { in: { passed: 4 }, out: { passed: 2 } };
  const base = evalOf(passes.in, passes.out);

  test("a material held-in progress gain with stable held-out is accepted", () => {
    // The case pass/fail cannot see: nothing flipped red→green, but the runs
    // resolved far more of their gate errors than before.
    const d = acceptanceDecision(
      withProgress(base, 0.4, 0.5),
      withProgress(base, 0.62, 0.5)
    );

    expect(d.accepted).toBe(true);
    expect(d.reason).toContain("progress gain");
    expect(d.reason).toContain("gate errors resolved");
  });

  test("a gain below the noise floor is rejected", () => {
    // The specific failure being fixed: the old cycle tie-break took a 20%
    // move as signal when single-task cycles swing 4-10, and its acceptances
    // did not survive the next round's re-measurement.
    const d = acceptanceDecision(
      withProgress(base, 0.5, 0.5),
      withProgress(base, 0.53, 0.5)
    );

    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("progress moved only");
  });

  test("held-in progress bought by damaging held-out is rejected", () => {
    const d = acceptanceDecision(
      withProgress(base, 0.4, 0.6),
      withProgress(base, 0.7, 0.4)
    );

    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("held-out progress regressed");
  });

  test("even a tiny held-out dip blocks a large held-in gain", () => {
    // No tolerance: the paper's rule is non-regression on held-out. Forgiving a
    // measurable held-out loss is exactly what that split exists to catch.
    // Noise is handled by demanding a material held-in GAIN, not by excusing
    // held-out losses.
    const d = acceptanceDecision(
      withProgress(base, 0.4, 0.6),
      withProgress(base, 0.9, 0.59)
    );

    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("held-out progress regressed");
  });

  test("held-out holding exactly level is fine", () => {
    const d = acceptanceDecision(
      withProgress(base, 0.4, 0.6),
      withProgress(base, 0.7, 0.6)
    );

    expect(d.accepted).toBe(true);
  });

  test("an unmeasured split fails CLOSED, on either side", () => {
    // A split with no graded figure was not measured. An unmeasured held-out
    // split cannot show non-regression, so accepting there promotes an edit on
    // no evidence that it generalises.
    for (const [i, o] of [
      [undefined, undefined],
      [0.9, undefined],
      [undefined, 0.9],
    ] as const) {
      const d = acceptanceDecision(
        withProgress(base, 0.4, 0.5),
        withProgress(base, i, o)
      );

      expect(d.accepted).toBe(false);
      expect(d.reason).toContain("not measured on both splits");
    }
  });

  test("a missing held-out candidate score is never reported as unchanged", () => {
    // The accept message used `outCand ?? outBase`, which printed "50%→50%"
    // for a candidate whose held-out progress was never recorded — fabricating
    // the evidence for its own acceptance.
    const d = acceptanceDecision(
      withProgress(base, 0.4, 0.5),
      withProgress(base, 0.9, undefined)
    );

    expect(d.accepted).toBe(false);
    expect(d.reason).not.toContain("50.0%→50.0%");
  });

  test("a progress gain still honours the held-out quality guard", () => {
    const d = acceptanceDecision(
      withProgress(evalOf(passes.in, { passed: 2, avgQuality: 4.0 }), 0.4, 0.5),
      withProgress(evalOf(passes.in, { passed: 2, avgQuality: 3.0 }), 0.8, 0.5)
    );

    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("held-out quality regressed");
  });

  test("a REGRESSED pass count is never rescued by better progress", () => {
    // Passing dominates: getting further on tasks it now fails is not a trade
    // the rule may make.
    const d = acceptanceDecision(
      withProgress(evalOf({ passed: 4 }, passes.out), 0.3, 0.5),
      withProgress(evalOf({ passed: 3 }, passes.out), 0.95, 0.5)
    );

    expect(d.accepted).toBe(false);
    expect(d.reason).toContain("regresses");
  });
});

const CANDIDATE: ICandidate = {
  id: "r0-c1",
  patch: {
    promptBlocks: {
      bootstrap: { mode: "append", text: "Create the artifact early." },
    },
  },
  audit: {
    targetPattern: "no-progress|edit-rejects|-",
    surface: "promptBlocks",
    expectedEffect: "Earlier artifact creation.",
    risks: "None expected.",
  },
};

const SPLITS: ISplits = { heldIn: ["math", "slugify"], heldOut: ["auth"] };

describe("validateCandidate", () => {
  test("rejects an empty patch without ever calling the evaluator", async () => {
    let called = 0;

    const evaluator: HarnessEvaluator = () => {
      called += 1;

      return Promise.resolve({
        evaluation: evalOf({}, {}),
        heldInRuns: [],
      });
    };

    const result = await validateCandidate(
      { ...CANDIDATE, patch: {} },
      emptyOverlay(),
      evalOf({ passed: 4 }, { passed: 2 }),
      SPLITS,
      evaluator
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("no editable surface");
    expect(called).toBe(0);
  });

  test("an erroring evaluation rejects — a candidate is never promoted on a missing result", async () => {
    const evaluator: HarnessEvaluator = () =>
      Promise.reject(new Error("endpoint down"));
    const result = await validateCandidate(
      CANDIDATE,
      emptyOverlay(),
      evalOf({ passed: 4 }, { passed: 2 }),
      SPLITS,
      evaluator
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("endpoint down");
  });

  test("infrastructure-errored runs reject with an infra reason, never a phantom regression", async () => {
    // The candidate eval "lost" 3 held-in passes — but they ERRORED, they
    // didn't fail. The verdict must say so instead of blaming the edit.
    const evaluator: HarnessEvaluator = () =>
      Promise.resolve({
        evaluation: evalOf({ passed: 1, errored: 3 }, { passed: 2 }),
        heldInRuns: [],
      });
    const result = await validateCandidate(
      CANDIDATE,
      emptyOverlay(),
      evalOf({ passed: 4 }, { passed: 2 }),
      SPLITS,
      evaluator
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("infrastructure errors");
    expect(result.reason).not.toContain("regresses");
  });
});

/** A failed held-in run with enough signal to mine (edit rejections). */
function failedRun(taskId: string): IMinedRun {
  const ev = (
    partial: Partial<ILoopEvent> & { kind: ILoopEvent["kind"] }
  ): ILoopEvent => ({
    task: taskId,
    message: "",
    ...partial,
  });

  return {
    taskId,
    passed: false,
    events: [
      ev({ kind: "start" }),
      ev({ kind: "tool", message: "tool_rejected: edit target not found" }),
      ev({ kind: "tool", message: "tool_rejected: edit target not found" }),
      ev({ kind: "stuck", message: "no progress" }),
    ],
  };
}

function passedRun(taskId: string): IMinedRun {
  return {
    taskId,
    passed: true,
    events: [
      { kind: "validated", task: taskId, message: "GREEN", passed: true },
      { kind: "done", task: taskId, message: "done" },
    ],
  };
}

const PROPOSAL = JSON.stringify({
  targetPattern: "no-progress|edit-rejects|-",
  surface: "promptBlocks",
  expectedEffect: "Re-read the file before every edit.",
  risks: "Slightly more read turns.",
  patch: {
    promptBlocks: {
      execution: {
        mode: "append",
        text: "Before each edit, re-read the target region so the snippet matches.",
      },
    },
  },
});

function proposerOf(responses: string[]): IProvider {
  let i = 0;

  return {
    complete: (_messages: IChatMessage[]): Promise<IModelResponse> => {
      const content = responses[i] ?? responses[responses.length - 1] ?? "{}";

      i += 1;

      return Promise.resolve({ content, toolCalls: [] });
    },
  };
}

describe("runSelfHarness — Algorithm 1 end-to-end (deterministic)", () => {
  test("accepted edit merges into h_1 and the loop stops when held-in goes green", async () => {
    // Programmed world: the base harness fails slugify; any overlay containing
    // the proposed execution-block edit fixes it without hurting held-out.
    const evaluator: HarnessEvaluator = (overlay) => {
      const fixed =
        overlay?.promptBlocks.execution?.text.includes("re-read the target") ??
        false;

      return Promise.resolve({
        evaluation: evalOf(
          { passed: fixed ? 2 : 1, runs: 2 },
          { passed: 1, runs: 1 }
        ),
        heldInRuns: fixed
          ? [passedRun("math"), passedRun("slugify")]
          : [passedRun("math"), failedRun("slugify")],
      });
    };

    const lineage = await runSelfHarness({
      model: "acme/test-model",
      rounds: 3,
      width: 2,
      splits: SPLITS,
      provider: proposerOf([PROPOSAL]),
      evaluator,
    });

    // Round 0: mined, proposed, accepted, merged.
    expect(lineage.rounds[0]?.acceptedIds).toContain("r0-c1");
    expect(lineage.finalOverlay.promptBlocks.execution?.text).toContain(
      "re-read the target"
    );

    // Round 1: h_1 is fully green held-in → early stop (not 3 full rounds).
    expect(lineage.rounds).toHaveLength(2);
    expect(lineage.rounds[1]?.candidates).toEqual([]);
    expect(lineage.notes.some((n) => n.includes("no failures to mine"))).toBe(
      true
    );
  });

  test("a regressive candidate is rejected and h_{t+1} = h_t", async () => {
    // Programmed world: the edit LOWERS held-out passes — must not merge.
    const evaluator: HarnessEvaluator = (overlay) => {
      const edited = overlay?.promptBlocks.execution !== undefined;

      return Promise.resolve({
        evaluation: evalOf(
          { passed: edited ? 2 : 1, runs: 2 },
          { passed: edited ? 0 : 1, runs: 1 }
        ),
        heldInRuns: [passedRun("math"), failedRun("slugify")],
      });
    };

    const lineage = await runSelfHarness({
      model: "acme/test-model",
      rounds: 1,
      width: 1,
      splits: SPLITS,
      provider: proposerOf([PROPOSAL]),
      evaluator,
    });

    expect(lineage.rounds[0]?.acceptedIds).toEqual([]);
    expect(lineage.finalOverlay.promptBlocks.execution).toBeUndefined();

    const rejected = lineage.rounds[0]?.candidates[0];

    expect(rejected?.accepted).toBe(false);
    expect(rejected?.reason).toContain("held-out");
  });

  test("prior attempts flow into the next round's proposer context", async () => {
    const prompts: IChatMessage[][] = [];
    const provider: IProvider = {
      complete: (messages): Promise<IModelResponse> => {
        prompts.push(messages);

        return Promise.resolve({ content: PROPOSAL, toolCalls: [] });
      },
    };
    // Never improves → every candidate rejected → 2 rounds of proposals.
    const evaluator: HarnessEvaluator = () =>
      Promise.resolve({
        evaluation: evalOf({ passed: 1, runs: 2 }, { passed: 1, runs: 1 }),
        heldInRuns: [passedRun("math"), failedRun("slugify")],
      });

    const lineage = await runSelfHarness({
      model: "acme/test-model",
      rounds: 2,
      width: 1,
      splits: SPLITS,
      provider,
      evaluator,
    });

    expect(lineage.rounds).toHaveLength(2);

    const round1User =
      prompts[1]?.find((m) => m.role === "user")?.content ?? "";

    expect(round1User).toContain("Previously attempted edits");
    expect(round1User).toContain("r0-c1 (rejected)");
  });

  test("an errored baseline retries once, then stops the loop — no verdict without a clean baseline", async () => {
    let calls = 0;

    const evaluator: HarnessEvaluator = () => {
      calls += 1;

      return Promise.resolve({
        evaluation: evalOf({ passed: 1, errored: 2, runs: 2 }, { passed: 1 }),
        heldInRuns: [passedRun("math"), failedRun("slugify")],
      });
    };

    const lineage = await runSelfHarness({
      model: "acme/test-model",
      rounds: 3,
      width: 2,
      splits: SPLITS,
      provider: proposerOf([PROPOSAL]),
      evaluator,
    });

    // baseline + one retry, then stop — no proposals, no further rounds
    expect(calls).toBe(2);
    expect(lineage.rounds).toEqual([]);
    expect(lineage.notes.some((n) => n.includes("retrying once"))).toBe(true);
    expect(lineage.notes.some((n) => n.includes("endpoint unhealthy"))).toBe(
      true
    );
  });

  test("the report renders the lineage with verdicts, deltas, and install path", async () => {
    const evaluator: HarnessEvaluator = (overlay) =>
      Promise.resolve({
        evaluation: evalOf(
          { passed: overlay === null ? 1 : 2, runs: 2 },
          { passed: 1, runs: 1 }
        ),
        heldInRuns: [passedRun("math"), failedRun("slugify")],
      });
    const lineage = await runSelfHarness({
      model: "acme/test-model",
      rounds: 1,
      width: 1,
      splits: SPLITS,
      provider: proposerOf([PROPOSAL]),
      evaluator,
    });
    const report = emitReport(lineage);

    expect(report.markdown).toContain("Self-Harness report — acme/test-model");
    expect(report.markdown).toContain("✅ ACCEPTED");
    expect(report.markdown).toContain("Δin=1");
    expect(report.markdown).toContain("never shown to the proposer");
    expect(report.markdown).toContain(
      "self-harness/acme-test-model/overlay.json"
    );
    expect(report.overlayJson).toContain("re-read the target");
    // rejected-vs-accepted accounting shows in the header
    expect(report.markdown).toContain("accepted: 1");
  });
});
