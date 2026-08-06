import { test, expect, describe } from "bun:test";
import {
  aggregateDiagnoses,
  diagnoseInvoke,
  type DiagOutcome,
} from "../src/reviewers/diagnose";
import type { IDiagnosis } from "../src/reviewers/diagnose-schema";
import type { IPanel } from "../src/reviewers/registry";
import type { IInvokeDeps } from "../src/reviewers/invoke";
import type { IModelResponse } from "../src/inference";

function ok(
  reviewerId: string,
  category: IDiagnosis["category"],
  suggestedFix = "fix"
): DiagOutcome {
  return {
    status: "ok",
    diagnosis: {
      reviewerId,
      category,
      confidence: "high",
      rootCause: "because",
      suggestedFix,
    },
  };
}

function err(reviewerId: string): DiagOutcome {
  return { status: "errored", reviewerId, error: "boom" };
}

describe("aggregateDiagnoses", () => {
  test("majority category wins; agreement counts the agreeing reviewers", () => {
    const c = aggregateDiagnoses(
      [
        ok("a", "gate-parity"),
        ok("b", "gate-parity"),
        ok("c", "near-green-oscillation"),
      ],
      2
    );

    expect(c.category).toBe("gate-parity");
    expect(c.agreement).toBe(2);
    expect(c.totalOk).toBe(3);
  });

  test("errored reviewers are counted but never vote", () => {
    const c = aggregateDiagnoses(
      [ok("a", "wrong-idiom"), err("b"), err("c")],
      1
    );

    expect(c.category).toBe("wrong-idiom");
    expect(c.totalOk).toBe(1);
    expect(c.totalErrored).toBe(2);
    expect(c.agreement).toBe(1);
  });

  test("no successful reviewer → null consensus, no crash", () => {
    const c = aggregateDiagnoses([err("a"), err("b")], 2);

    expect(c.category).toBeNull();
    expect(c.totalOk).toBe(0);
    expect(c.suggestedFixes).toEqual([]);
  });

  test("a tie resolves to the earlier (more structural) category", () => {
    // gate-parity precedes near-green-oscillation in FAILURE_CATEGORIES.
    const c = aggregateDiagnoses(
      [ok("a", "near-green-oscillation"), ok("b", "gate-parity")],
      2
    );

    expect(c.category).toBe("gate-parity");
    expect(c.agreement).toBe(1);
  });

  test("sufficient is false when fewer than minReviewers succeeded", () => {
    const thin = aggregateDiagnoses([ok("a", "gate-parity"), err("b")], 2);

    expect(thin.category).toBe("gate-parity"); // still reported
    expect(thin.sufficient).toBe(false); // but flagged as not an independent verdict
    expect(thin.minReviewers).toBe(2);

    const full = aggregateDiagnoses(
      [ok("a", "gate-parity"), ok("b", "gate-parity")],
      2
    );

    expect(full.sufficient).toBe(true);
  });

  test("suggestedFixes are the distinct fixes from the consensus voters only", () => {
    const c = aggregateDiagnoses(
      [
        ok("a", "gate-parity", "make gates identical"),
        ok("b", "gate-parity", "make gates identical"),
        ok("c", "gate-parity", "run prettier at write time"),
        ok("d", "scaffold-infra", "irrelevant fix"),
      ],
      2
    );

    expect(c.category).toBe("gate-parity");
    expect(c.suggestedFixes).toHaveLength(2);
    expect(c.suggestedFixes).toContain("make gates identical");
    expect(c.suggestedFixes).toContain("run prettier at write time");
    expect(c.suggestedFixes).not.toContain("irrelevant fix");
  });
});

const GOOD_DIAGNOSIS = JSON.stringify({
  category: "gate-parity",
  confidence: "high",
  rootCause: "phantom learned rule vs real eslint",
  suggestedFix: "reconcile learned rules against the validator",
});

function modelResponse(content: string): IModelResponse {
  return { content, toolCalls: [] };
}

const REQUEST = {
  domain: "expense",
  parkReason: "ladder exhausted, parked",
  turnsSummary: "141 cycles",
  logSlice: "[fix] parked",
  sliceNote: "compacted",
};

describe("diagnoseInvoke (invoke → parse → outcome)", () => {
  test("a model reviewer returning valid JSON becomes a vote", async () => {
    const panel: IPanel = {
      minReviewers: 1,
      skipped: [],
      reviewers: [
        { kind: "model", id: "m1", entry: { baseUrl: "http://x", model: "z" } },
      ],
    };
    const deps: IInvokeDeps = {
      makeProvider: () => ({
        complete: () => Promise.resolve(modelResponse(GOOD_DIAGNOSIS)),
      }),
      runBinary: () =>
        Promise.resolve({
          ok: true,
          stdout: "",
          timedOut: false,
          truncated: false,
          stoppedBy: "eof" as const,
        }),
    };

    const [outcome] = await diagnoseInvoke(panel, REQUEST, deps);

    expect(outcome?.status).toBe("ok");

    if (outcome?.status === "ok") {
      expect(outcome.diagnosis.category).toBe("gate-parity");
      expect(outcome.diagnosis.reviewerId).toBe("m1");
    }
  });

  test("extracts JSON even when the model wraps it in prose", async () => {
    const panel: IPanel = {
      minReviewers: 1,
      skipped: [],
      reviewers: [
        { kind: "model", id: "m1", entry: { baseUrl: "http://x", model: "z" } },
      ],
    };
    const deps: IInvokeDeps = {
      makeProvider: () => ({
        complete: () =>
          Promise.resolve(
            modelResponse(`Sure, here you go:\n${GOOD_DIAGNOSIS}\nThanks`)
          ),
      }),
      runBinary: () =>
        Promise.resolve({
          ok: true,
          stdout: "",
          timedOut: false,
          truncated: false,
          stoppedBy: "eof" as const,
        }),
    };

    const [outcome] = await diagnoseInvoke(panel, REQUEST, deps);

    expect(outcome?.status).toBe("ok");
  });

  test("malformed output makes the reviewer errored, never a vote", async () => {
    const panel: IPanel = {
      minReviewers: 1,
      skipped: [],
      reviewers: [
        { kind: "model", id: "m1", entry: { baseUrl: "http://x", model: "z" } },
      ],
    };
    const deps: IInvokeDeps = {
      makeProvider: () => ({
        complete: () => Promise.resolve(modelResponse("not json")),
      }),
      runBinary: () =>
        Promise.resolve({
          ok: true,
          stdout: "",
          timedOut: false,
          truncated: false,
          stoppedBy: "eof" as const,
        }),
    };

    const [outcome] = await diagnoseInvoke(panel, REQUEST, deps);

    expect(outcome?.status).toBe("errored");
  });

  test("a binary reviewer that exits non-zero is errored", async () => {
    const panel: IPanel = {
      minReviewers: 1,
      skipped: [],
      reviewers: [
        {
          kind: "binary",
          id: "b1",
          argv: ["x"],
          input: "arg",
          timeoutMs: 1000,
          parse: "raw",
        },
      ],
    };
    const deps: IInvokeDeps = {
      makeProvider: () => ({
        complete: () => Promise.resolve(modelResponse("")),
      }),
      runBinary: () =>
        Promise.resolve({
          ok: false,
          stdout: "",
          timedOut: false,
          truncated: false,
          stoppedBy: "eof" as const,
        }),
    };

    const [outcome] = await diagnoseInvoke(panel, REQUEST, deps);

    expect(outcome?.status).toBe("errored");
  });

  test("a TIMED-OUT binary's partial JSON is not counted as a vote", async () => {
    // The diagnose path had the same `ok`-only check the review path lost: a
    // runner reporting ok:true alongside timedOut:true would have its output
    // parsed, so a diagnosis cut off mid-sentence counted as a real one. A
    // partial answer is not a diagnosis any more than it is a review.
    const panel: IPanel = {
      minReviewers: 1,
      skipped: [],
      reviewers: [
        {
          kind: "binary",
          id: "grok",
          argv: ["x"],
          input: "arg",
          timeoutMs: 4321,
          parse: "raw",
        },
      ],
    };
    const deps: IInvokeDeps = {
      makeProvider: () => ({
        complete: () => Promise.resolve(modelResponse("")),
      }),
      // Deliberately VALID output: the point is that it is refused for having
      // been cut off, not for being malformed.
      runBinary: () =>
        Promise.resolve({
          ok: true,
          stdout: GOOD_DIAGNOSIS,
          timedOut: true,
          truncated: false,
          stoppedBy: "eof" as const,
        }),
    };

    const [outcome] = await diagnoseInvoke(panel, REQUEST, deps);

    expect(outcome?.status).toBe("errored");

    if (outcome?.status === "errored") {
      expect(outcome.error).toContain("4321");
      expect(outcome.error).toContain("timeout");
    }
  });

  test("a TRUNCATED binary's output is not counted as a vote either", async () => {
    // Parallel to the timeout case, and the same asymmetry: the review path
    // refuses a prefix while diagnose fell through to "binary exited non-zero",
    // blaming the binary for something the harness did — or, for a runner
    // reporting ok:true alongside the flag, counting a cut-off diagnosis as a
    // real one.
    const panel: IPanel = {
      minReviewers: 1,
      skipped: [],
      reviewers: [
        {
          kind: "binary",
          id: "grok",
          argv: ["x"],
          input: "arg",
          timeoutMs: 1000,
          parse: "raw",
        },
      ],
    };
    const deps: IInvokeDeps = {
      makeProvider: () => ({
        complete: () => Promise.resolve(modelResponse("")),
      }),
      // A real production combination: the ceiling was hit, so the read stopped
      // on `size`. The previous fixture said truncated with stoppedBy "eof",
      // which runBinary can never produce — so it exercised neither real case.
      runBinary: () =>
        Promise.resolve({
          ok: true,
          stdout: GOOD_DIAGNOSIS,
          timedOut: false,
          truncated: true,
          stoppedBy: "size" as const,
        }),
    };

    const [outcome] = await diagnoseInvoke(panel, REQUEST, deps);

    expect(outcome?.status).toBe("errored");

    if (outcome?.status === "errored") {
      expect(outcome.error).toContain("flooded");
    }
  });

  test("a timed-out diagnosis with an orphaned pipe reports the TIMEOUT", async () => {
    // Both flags true with a deadline stop is a binary killed at its budget
    // whose child still holds stdout. The timeout is why it died; reporting
    // truncation hides that on the path that happens most.
    const panel: IPanel = {
      minReviewers: 1,
      skipped: [],
      reviewers: [
        {
          kind: "binary",
          id: "grok",
          argv: ["x"],
          input: "arg",
          timeoutMs: 8888,
          parse: "raw",
        },
      ],
    };
    const deps: IInvokeDeps = {
      makeProvider: () => ({
        complete: () => Promise.resolve(modelResponse("")),
      }),
      runBinary: () =>
        Promise.resolve({
          ok: false,
          stdout: "partial",
          timedOut: true,
          truncated: true,
          stoppedBy: "deadline" as const,
        }),
    };

    const [outcome] = await diagnoseInvoke(panel, REQUEST, deps);

    expect(outcome?.status).toBe("errored");

    if (outcome?.status === "errored") {
      expect(outcome.error).toContain("8888");
    }
  });

  test("a binary reviewer returning valid JSON on stdout becomes a vote", async () => {
    const panel: IPanel = {
      minReviewers: 1,
      skipped: [],
      reviewers: [
        {
          kind: "binary",
          id: "grok",
          argv: ["x"],
          input: "arg",
          timeoutMs: 1000,
          parse: "raw",
        },
      ],
    };
    const deps: IInvokeDeps = {
      makeProvider: () => ({
        complete: () => Promise.resolve(modelResponse("")),
      }),
      runBinary: () =>
        Promise.resolve({
          ok: true,
          stdout: GOOD_DIAGNOSIS,
          timedOut: false,
          truncated: false,
          stoppedBy: "eof" as const,
        }),
    };

    const [outcome] = await diagnoseInvoke(panel, REQUEST, deps);

    expect(outcome?.status).toBe("ok");

    if (outcome?.status === "ok") {
      expect(outcome.diagnosis.reviewerId).toBe("grok");
    }
  });
});
