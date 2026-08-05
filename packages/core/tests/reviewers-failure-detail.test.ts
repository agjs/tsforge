import { test, expect, describe } from "bun:test";
import { aggregate, parseVerdict } from "../src/reviewers/aggregate";
import type { ReviewOutcome } from "../src/reviewers/aggregate";
import { formatVerdict, runBinary } from "../src/cli/harness-review-mode";

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
