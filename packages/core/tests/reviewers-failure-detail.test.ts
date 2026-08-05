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

  test("missing failure detail is SAID, not silently a shorter list", () => {
    // A cached artifact from an older build carries counts but no detail. Left
    // alone the printed verdict shows a complete-looking (empty) list beside
    // "errored: 2" and silently regresses to the count-only state this change
    // exists to leave behind.
    const v = aggregate([okOutcome("a"), okOutcome("b")], opts);
    const raw: unknown = {
      ...JSON.parse(JSON.stringify(v)),
      reviewers: { ok: 2, errored: 2 },
    };
    const parsed = parseVerdict(raw);

    expect(formatVerdict(parsed ?? v)).toContain(
      "2 further reviewer failure(s) with no readable detail"
    );
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

  test("a binary that TRAPS the kill and exits 0 is still not ok", async () => {
    // The case `ok: code === 0` alone gets wrong, and the reason the plain
    // `sleep` test above does not cover it: sleep dies on SIGTERM and exits
    // non-zero, so ok is false either way and the suite would still pass with
    // `&& !timedOut` deleted. A binary that handles SIGTERM cleanly exits 0
    // while having produced only a partial answer.
    const r = await runBinary(
      {
        // `& wait` so the trap fires on arrival: with a FOREGROUND sleep, sh
        // defers the handler until the child finishes, and the kill looks slow
        // rather than trapped. (The backgrounded child also holds the stdout
        // pipe open until it exits, which is why this sleeps 2s and not 30.)
        argv: ["sh", "-c", "trap 'exit 0' TERM; echo partial; sleep 2 & wait"],
        input: "arg",
        timeoutMs: 800,
      },
      ""
    );

    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  }, 30_000);

  test("a binary that IGNORES SIGTERM is still killed, not waited on", async () => {
    // SIGTERM is a request. Without escalation an unkillable reviewer holds the
    // whole panel past a budget that exists to stop exactly that, and the
    // timeout outcome never arrives. The trap test above exits voluntarily and
    // so cannot catch this.
    const started = Date.now();
    const r = await runBinary(
      {
        argv: ["sh", "-c", "trap '' TERM; sleep 20 & wait"],
        input: "arg",
        timeoutMs: 500,
      },
      ""
    );

    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    // Budget + grace + drain, not the full 20s.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("an orphan holding the pipe means the read is REPORTED incomplete", async () => {
    // The parent answers and exits at once; a backgrounded child keeps stdout
    // open. We stop reading, and we say so: not reaching EOF means we cannot
    // claim the answer is complete, and whether that orphan is idle or still
    // writing cannot be decided from here — a writer slower than the grace looks
    // identical to one that has finished.
    //
    // The cost is refusing a review from any reviewer that backgrounds work.
    // That is visible, with cause `truncated`. Passing a prefix off as a
    // finished review is not, and a wrong verdict is worse than a missing one.
    const started = Date.now();
    const r = await runBinary(
      {
        argv: ["sh", "-c", "echo done; sleep 6 &"],
        input: "arg",
        timeoutMs: 30_000,
      },
      ""
    );

    expect(r.stdout).toContain("done");
    expect(r.truncated).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
    // Returned on the drain bound rather than waiting out the child.
    expect(Date.now() - started).toBeLessThan(5_000);
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
        Promise.resolve({
          ok: false,
          stdout: "",
          timedOut: true,
          truncated: false,
        }),
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
        Promise.resolve({
          ok: false,
          stdout: "",
          timedOut: false,
          truncated: false,
        }),
    });

    expect(out[0]).toMatchObject({ cause: "exit" });
  });

  test("a truncated read is cause=truncated, not unparseable", async () => {
    // We stopped listening; the reviewer may have been perfectly fine. Calling
    // its prefix unparseable sends the next person to debug the wrong thing.
    const out = await reviewerInvoke(binaryPanel(), request, {
      makeProvider: deadProvider,
      runBinary: () =>
        Promise.resolve({
          ok: false,
          stdout: '{"verdict":"appr',
          timedOut: false,
          truncated: true,
        }),
    });

    expect(out[0]).toMatchObject({ cause: "truncated" });
  });

  test("a binary that answers in the wrong shape is cause=unparseable", async () => {
    const out = await reviewerInvoke(binaryPanel(), request, {
      makeProvider: deadProvider,
      runBinary: () =>
        Promise.resolve({
          ok: true,
          stdout: "sure, looks fine!",
          timedOut: false,
          truncated: false,
        }),
    });

    expect(out[0]).toMatchObject({ cause: "unparseable" });
  });

  test("every failure carries elapsed ms, not just a cause", async () => {
    // A runner that omitted ms on failures would otherwise pass the suite, and
    // "how long did it burn" is half the diagnostic.
    const out = await reviewerInvoke(binaryPanel(), request, {
      makeProvider: deadProvider,
      runBinary: () =>
        Promise.resolve({
          ok: false,
          stdout: "",
          timedOut: false,
          truncated: false,
        }),
    });
    const outcome = out[0];

    expect(outcome?.status).toBe("errored");

    if (outcome?.status === "errored") {
      expect(typeof outcome.ms).toBe("number");
      expect(Number.isFinite(outcome.ms)).toBe(true);
    }
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
        Promise.resolve({
          ok: false,
          stdout: "",
          timedOut: false,
          truncated: false,
        }),
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
          truncated: false,
        }),
    });

    const outcome = out[0];

    // Narrowed on status, not cast: the house rule forbids `as` (except
    // `as const`), and narrowing is what makes ms reachable honestly.
    expect(outcome?.status).toBe("ok");

    if (outcome?.status === "ok") {
      expect(typeof outcome.ms).toBe("number");
    }
  });

  test("a runner reporting ok WITH timedOut is still not a review", async () => {
    // Defence in depth. runBinary forces ok=false on a kill, but invokeBinary
    // must not depend on that: any runner meeting the contract could report
    // `ok: true, timedOut: true`, and parsing stdout there counts a reviewer we
    // killed mid-sentence as having reviewed.
    const out = await reviewerInvoke(binaryPanel(999), request, {
      makeProvider: deadProvider,
      runBinary: () =>
        Promise.resolve({
          ok: true,
          stdout: '{"verdict":"approve","summary":"","findings":[]}',
          timedOut: true,
          truncated: false,
        }),
    });

    expect(out[0]?.status).toBe("errored");
    expect(out[0]).toMatchObject({ cause: "timeout" });
  });
});
