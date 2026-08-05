import { test, expect, describe } from "bun:test";
import { aggregate, parseVerdict } from "../src/reviewers/aggregate";
import type { ReviewOutcome } from "../src/reviewers/aggregate";
import { formatVerdict, runBinary } from "../src/cli/harness-review-mode";
import { reviewerInvoke } from "../src/reviewers/invoke";
import type { IPanel } from "../src/reviewers/registry";
import type { IReviewRequest } from "../src/reviewers/schema";
import type { IProvider } from "../src/inference";

/**
 * Why a reviewer dropped out, kept rather than discarded.
 *
 * `reviewers ok: 2  errored: 2` is the same line whether two binaries are
 * misconfigured or the whole panel timed out on a large diff — and those imply
 * opposite fixes (fix the binary vs raise the budget). Worse, the binary path
 * reported "binary exited non-zero or timed out" for both at once, so even
 * reading the stored artifact could not tell them apart. Answering "is a
 * reviewer wasting our time or is it broken?" took an afternoon of timing the
 * binaries by hand; it should take reading one line.
 */

const opts = { minReviewers: 2, identity: "local/flash" };

function okOutcome(id: string): ReviewOutcome {
  return {
    status: "ok",
    review: { reviewerId: id, verdict: "approve", findings: [], summary: "" },
    ms: 0,
  };
}

describe("reviewer failure detail", () => {
  test("names each failed reviewer, with cause and elapsed time", () => {
    const v = aggregate(
      [
        okOutcome("a"),
        okOutcome("b"),
        {
          status: "errored",
          reviewerId: "codex",
          error: "binary hit its 300000ms timeout",
          cause: "timeout",
          ms: 300_012,
        },
      ],
      opts
    );

    expect(v.reviewers).toEqual({ ok: 2, errored: 1 });
    expect(v.failures).toHaveLength(1);
    expect(v.failures?.[0]?.reviewerId).toBe("codex");
    expect(v.failures?.[0]?.cause).toBe("timeout");
    expect(v.failures?.[0]?.ms).toBe(300_012);
  });

  test("a timeout and a crash are DIFFERENT causes, not one string", () => {
    // The regression that made this undiagnosable: both arrived as
    // "binary exited non-zero or timed out", so the artifact could not answer
    // whether the budget was too small or the binary was broken.
    const v = aggregate(
      [
        okOutcome("a"),
        okOutcome("b"),
        {
          status: "errored",
          reviewerId: "slow",
          error: "timed out",
          cause: "timeout",
          ms: 300_000,
        },
        {
          status: "errored",
          reviewerId: "broken",
          error: "binary exited non-zero",
          cause: "exit",
          ms: 120,
        },
      ],
      opts
    );
    const causes = (v.failures ?? []).map((f) => f.cause);

    expect(causes).toEqual(["timeout", "exit"]);
  });

  test("a clean panel carries no failures field at all", () => {
    const v = aggregate([okOutcome("a"), okOutcome("b")], opts);

    expect(v.failures).toBeUndefined();
  });

  test("the printed verdict shows who dropped out and why", () => {
    const v = aggregate(
      [
        okOutcome("a"),
        okOutcome("b"),
        {
          status: "errored",
          reviewerId: "codex",
          error: "binary hit its 300000ms timeout",
          cause: "timeout",
          ms: 300_500,
        },
      ],
      opts
    );
    const out = formatVerdict(v);

    expect(out).toContain("codex did not review");
    expect(out).toContain("timeout");
    // Seconds, because "300500" in a terminal is not a duration anyone reads.
    expect(out).toContain("300.5s");
  });

  test("failures survive the cache round-trip", () => {
    const v = aggregate(
      [
        okOutcome("a"),
        okOutcome("b"),
        {
          status: "errored",
          reviewerId: "codex",
          error: "binary hit its 300000ms timeout",
          cause: "timeout",
          ms: 300_000,
        },
      ],
      opts
    );
    const raw: unknown = JSON.parse(JSON.stringify(v));
    const parsed = parseVerdict(raw);

    expect(parsed?.failures?.[0]?.cause).toBe("timeout");
    expect(parsed?.failures?.[0]?.ms).toBe(300_000);
  });

  test("a malformed failure entry is dropped, not treated as a corrupt verdict", () => {
    // Diagnostics are informational. Losing one line must not invalidate an
    // otherwise good cached verdict and force the whole panel to re-run.
    const v = aggregate([okOutcome("a"), okOutcome("b")], opts);
    const raw: unknown = {
      ...JSON.parse(JSON.stringify(v)),
      failures: [{ reviewerId: 7 }, { reviewerId: "ok-one", error: "boom" }],
    };
    const parsed = parseVerdict(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.failures).toHaveLength(1);
    expect(parsed?.failures?.[0]?.reviewerId).toBe("ok-one");
  });

  test("a non-finite ms is dropped rather than printed as NaNs", () => {
    const v = aggregate([okOutcome("a"), okOutcome("b")], opts);
    const raw: unknown = {
      ...JSON.parse(JSON.stringify(v)),
      failures: [{ reviewerId: "x", error: "boom", ms: Number.NaN }],
    };
    const parsed = parseVerdict(raw);

    expect(parsed?.failures?.[0]?.ms).toBeUndefined();
    expect(formatVerdict(parsed ?? v)).not.toContain("NaN");
  });

  test("an unknown cause string is dropped rather than trusted", () => {
    const v = aggregate([okOutcome("a"), okOutcome("b")], opts);
    const raw: unknown = {
      ...JSON.parse(JSON.stringify(v)),
      failures: [{ reviewerId: "x", error: "boom", cause: "banana" }],
    };
    const parsed = parseVerdict(raw);

    expect(parsed?.failures?.[0]?.cause).toBeUndefined();
  });
});

describe("runBinary reports WHICH failure it was", () => {
  /**
   * The distinction has to be recorded at the kill site: a process we killed
   * exits non-zero exactly like one that failed on its own, so the exit code
   * cannot tell them apart afterwards. Only the killer knows.
   */
  test("a process killed at the budget is marked timedOut", async () => {
    const r = await runBinary(
      { argv: ["sh", "-c", "sleep 30"], input: "arg", timeoutMs: 800 },
      ""
    );

    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  }, 30_000);

  test("a process that exits non-zero on its own is NOT marked timedOut", async () => {
    const r = await runBinary(
      { argv: ["sh", "-c", "exit 3"], input: "arg", timeoutMs: 30_000 },
      ""
    );

    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
  }, 30_000);

  test("a healthy process is neither", async () => {
    const r = await runBinary(
      { argv: ["sh", "-c", "echo hi"], input: "arg", timeoutMs: 30_000 },
      ""
    );

    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(false);
  }, 30_000);
});

describe("cause classification through reviewerInvoke", () => {
  /**
   * The glue. runBinary proves the subprocess reports timedOut and aggregate
   * proves causes round-trip, but invokeBinary/invokeModel is where the old
   * "binary exited non-zero or timed out" conflation actually lived — so an
   * implementation that always emitted `exit`, or dropped cause/ms entirely,
   * would pass every other test in this suite.
   */
  const request: IReviewRequest = {
    title: "t",
    intent: "i",
    diff: "d",
    validateSummary: { passed: true, failCount: 0, firstErrors: [] },
    rubricVersion: "1",
  };

  const binaryPanel = (timeoutMs = 1000): IPanel => ({
    minReviewers: 1,
    skipped: [],
    reviewers: [
      {
        kind: "binary",
        id: "bin",
        argv: ["x"],
        input: "arg",
        timeoutMs,
        parse: "raw",
      },
    ],
  });

  const deadProvider = (): IProvider => ({
    complete: () => Promise.reject(new Error("connection refused")),
  });

  test("a binary killed at its budget is cause=timeout, not exit", async () => {
    const out = await reviewerInvoke(binaryPanel(1234), request, {
      makeProvider: deadProvider,
      runBinary: () =>
        Promise.resolve({ ok: false, stdout: "", timedOut: true }),
    });

    expect(out[0]?.status).toBe("errored");
    expect(out[0]).toMatchObject({ cause: "timeout" });
    // The budget is named, so the fix (raise it, or drop the reviewer) is
    // readable straight off the line.
    expect(out[0]).toMatchObject({ error: expect.stringContaining("1234") });
  });

  test("a binary that fails on its own is cause=exit, not timeout", async () => {
    const out = await reviewerInvoke(binaryPanel(), request, {
      makeProvider: deadProvider,
      runBinary: () =>
        Promise.resolve({ ok: false, stdout: "", timedOut: false }),
    });

    expect(out[0]).toMatchObject({ cause: "exit" });
  });

  test("a binary that answers in the wrong shape is cause=unparseable", async () => {
    const out = await reviewerInvoke(binaryPanel(), request, {
      makeProvider: deadProvider,
      runBinary: () =>
        Promise.resolve({
          ok: true,
          stdout: "sure, looks fine!",
          timedOut: false,
        }),
    });

    expect(out[0]).toMatchObject({ cause: "unparseable" });
  });

  test("a model whose call throws is cause=threw", async () => {
    const panel: IPanel = {
      minReviewers: 1,
      skipped: [],
      reviewers: [
        { kind: "model", id: "m", entry: { model: "x", baseUrl: "u" } },
      ],
    };
    const out = await reviewerInvoke(panel, request, {
      makeProvider: deadProvider,
      runBinary: () =>
        Promise.resolve({ ok: false, stdout: "", timedOut: false }),
    });

    expect(out[0]).toMatchObject({ cause: "threw" });
    expect(out[0]).toMatchObject({
      error: expect.stringContaining("connection refused"),
    });
  });

  test("every outcome carries elapsed time, successes included", async () => {
    const out = await reviewerInvoke(binaryPanel(), request, {
      makeProvider: deadProvider,
      runBinary: () =>
        Promise.resolve({
          ok: true,
          stdout: '{"verdict":"approve","summary":"","findings":[]}',
          timedOut: false,
        }),
    });

    expect(out[0]?.status).toBe("ok");
    expect(typeof (out[0] as { ms?: number }).ms).toBe("number");
  });
});
