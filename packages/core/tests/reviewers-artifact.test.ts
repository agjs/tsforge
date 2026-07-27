import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import {
  reviewRequestKey,
  panelIdentityHash,
  runReviewFlow,
  canonicalJson,
  artifactBody,
  honorCachedVerdict,
  CACHE_VERSION,
} from "../src/reviewers/harness-review";
import type { GatherResult } from "../src/reviewers/harness-review";
import type { IReviewRequest } from "../src/reviewers/schema";
import type { IVerdict } from "../src/reviewers/aggregate";

const v: IVerdict = {
  blocked: false,
  reason: "all reviewers approved",
  reviewers: { ok: 2, errored: 0 },
  ranked: [],
  perReviewer: [],
  identity: "local/flash",
};

const request: IReviewRequest = {
  title: "add the widget",
  intent: "add the widget",
  diff: "diff --git a/x b/x\n+code",
  validateSummary: { passed: true, failCount: 0, firstErrors: [] },
  contextFiles: ["=== x.ts ===\nexport const x = 1;"],
  rubricVersion: "1",
};

const rosterOpts = { rosterHash: "r1", mode: "full" };

describe("reviewRequestKey (cache key = fingerprint of the ACTUAL review request)", () => {
  test("stable for the same request + roster + mode", () => {
    expect(reviewRequestKey(request, rosterOpts)).toBe(
      reviewRequestKey(request, rosterOpts)
    );
  });

  test("every reviewer-visible dimension changes the key — diff, contextFiles, intent, rubric, validateSummary, roster, mode", () => {
    const base = reviewRequestKey(request, rosterOpts);

    expect(
      reviewRequestKey({ ...request, diff: "different" }, rosterOpts)
    ).not.toBe(base);
    // contextFiles: a rebase can yield an identical diff but different surrounding file
    // content — the reviewers see this, so it MUST change the key.
    expect(
      reviewRequestKey(
        { ...request, contextFiles: ["=== x.ts ===\nother"] },
        rosterOpts
      )
    ).not.toBe(base);
    expect(
      reviewRequestKey({ ...request, intent: "different" }, rosterOpts)
    ).not.toBe(base);
    expect(
      reviewRequestKey({ ...request, rubricVersion: "2" }, rosterOpts)
    ).not.toBe(base);
    // validateSummary is part of the request the reviewers read (firstErrors can differ even
    // on a passing run), so a different summary MUST change the key — no false reuse.
    expect(
      reviewRequestKey(
        {
          ...request,
          validateSummary: {
            passed: true,
            failCount: 0,
            firstErrors: ["a stray 'error' line"],
          },
        },
        rosterOpts
      )
    ).not.toBe(base);
    expect(
      reviewRequestKey(request, { ...rosterOpts, rosterHash: "r2" })
    ).not.toBe(base);
    expect(
      reviewRequestKey(request, { ...rosterOpts, mode: "quick" })
    ).not.toBe(base);
  });

  test("unforgeable: a value sliding across a field boundary can't collide two distinct requests", () => {
    // JSON serialization keeps ('a','b c') distinct from ('a b','c').
    expect(
      reviewRequestKey({ ...request, diff: "a", intent: "b c" }, rosterOpts)
    ).not.toBe(
      reviewRequestKey({ ...request, diff: "a b", intent: "c" }, rosterOpts)
    );
  });

  test("CACHE_VERSION is mixed into the key — bumping it retires ALL legacy artifacts in one shot", () => {
    // The ONLY lever that invalidates every already-on-disk artifact (e.g. legacy diff-hash
    // keys, or a poisoned pre-review block). If a regression dropped CACHE_VERSION from the
    // hashed array, one-shot invalidation would silently break while every other test stayed
    // green — so pin it by recomputing the exact key WITH it and asserting equality.
    const expected = createHash("sha256")
      .update(
        canonicalJson([
          request,
          rosterOpts.rosterHash,
          rosterOpts.mode,
          CACHE_VERSION,
        ])
      )
      .digest("hex");

    expect(reviewRequestKey(request, rosterOpts)).toBe(expected);

    // And a different CACHE_VERSION would produce a different key (the invalidation itself).
    const otherVersion = createHash("sha256")
      .update(
        canonicalJson([
          request,
          rosterOpts.rosterHash,
          rosterOpts.mode,
          "OTHER",
        ])
      )
      .digest("hex");

    expect(reviewRequestKey(request, rosterOpts)).not.toBe(otherVersion);
  });
});

describe("panelIdentityHash (the roster that ACTUALLY reviewed keys the cache)", () => {
  const grok = {
    kind: "model",
    id: "grok",
    entry: { baseUrl: "http://a", model: "g1" },
  };
  const codex = { kind: "binary", id: "codex", argv: ["codex"] };
  const panel = { reviewers: [grok, codex], minReviewers: 2 };

  test("stable and order-independent (roster is sorted by id before hashing)", () => {
    expect(panelIdentityHash(panel, "local/flash")).toBe(
      panelIdentityHash(
        { reviewers: [codex, grok], minReviewers: 2 },
        "local/flash"
      )
    );
  });

  test("adding/dropping a reviewer, changing the quorum, or changing the builder all change the key", () => {
    const base = panelIdentityHash(panel, "local/flash");

    expect(
      panelIdentityHash({ reviewers: [grok], minReviewers: 2 }, "local/flash")
    ).not.toBe(base); // a dropped reviewer (effective roster ≠ configured) must not reuse
    expect(
      panelIdentityHash({ ...panel, minReviewers: 1 }, "local/flash")
    ).not.toBe(base);
    expect(panelIdentityHash(panel, "other/model")).not.toBe(base); // different builder
  });

  test("RETARGETING the same id to a different model/endpoint/binary changes the key (reviewer implementation is pinned, not just its id)", () => {
    // The panel finding: hashing ids alone would reuse a verdict produced by a DIFFERENT
    // reviewer implementation. Full config is hashed, so same-id-different-model differs.
    const grokRetargeted = {
      kind: "model",
      id: "grok",
      entry: { baseUrl: "http://a", model: "g2-DIFFERENT" },
    };

    expect(
      panelIdentityHash(
        { reviewers: [grokRetargeted, codex], minReviewers: 2 },
        "local/flash"
      )
    ).not.toBe(panelIdentityHash(panel, "local/flash"));
  });
});

describe("runReviewFlow (the CLI wiring invariant: gather-before-cache, block-never-caches)", () => {
  const reviewVerdict: IVerdict = { ...v, reason: "fresh review" };
  const cachedVerdict: IVerdict = { ...v, reason: "from cache" };

  interface ICalls {
    gather: number;
    read: number;
    review: number;
    persist: string[];
  }

  // A flow harness: `gathered` is what gather() returns (block or request); records the
  // order/counts so the wiring invariant can be asserted, and captures the key each cache
  // op received (to prove it derives from the gathered request).
  const harness = (gathered: GatherResult, cached: IVerdict | null) => {
    const calls: ICalls = { gather: 0, read: 0, review: 0, persist: [] };
    const deps = {
      gather: async () => {
        calls.gather += 1;

        return gathered;
      },
      identity: "local/flash",
      rosterHash: "roster-1",
      mode: "full",
      ci: false,
      readCache: async (key: string) => {
        calls.read += 1;
        void key;

        return cached;
      },
      review: async (_request: IReviewRequest) => {
        calls.review += 1;

        return reviewVerdict;
      },
      persist: async (_verdict: IVerdict, key: string) => {
        calls.persist.push(key);
      },
    };

    return { calls, deps };
  };

  const requestResult: GatherResult = { kind: "request", request };

  test("a gather BLOCK (validate red / precondition) returns a blocked verdict WITHOUT touching the cache", async () => {
    // The central invariant: no cache read AND no write when the gate is red — a verdict is
    // never reused across a failing validate, and a transient block is never persisted.
    const { calls, deps } = harness(
      { kind: "block", reason: "validate failed (3 errors)" },
      cachedVerdict
    );

    const r = await runReviewFlow(deps);

    expect(r.verdict.blocked).toBe(true);
    expect(r.verdict.preReview).toBe(true);
    expect(calls.gather).toBe(1);
    expect(calls.read).toBe(0);
    expect(calls.review).toBe(0);
    expect(calls.persist).toHaveLength(0);
  });

  test("gather runs BEFORE any cache access, and the cache key is derived from the gathered request", async () => {
    const { calls, deps } = harness(requestResult, null);

    await runReviewFlow(deps);

    // The key the cache saw is exactly reviewRequestKey(gathered.request, roster/mode).
    const expectedKey = reviewRequestKey(request, {
      rosterHash: "roster-1",
      mode: "full",
    });

    expect(calls.gather).toBe(1);
    expect(calls.persist).toEqual([expectedKey]);
  });

  test("cache HIT reuses the cached verdict — gather ran, but no review, no write", async () => {
    const { calls, deps } = harness(requestResult, cachedVerdict);

    const r = await runReviewFlow(deps);

    expect(r.cacheHit).toBe(true);
    expect(r.verdict.reason).toBe("from cache");
    expect(calls.gather).toBe(1);
    expect(calls.review).toBe(0);
    expect(calls.persist).toHaveLength(0);
  });

  test("cache MISS runs the review and writes under the derived key", async () => {
    const { calls, deps } = harness(requestResult, null);

    const r = await runReviewFlow(deps);

    expect(r.cacheHit).toBe(false);
    expect(r.verdict.reason).toBe("fresh review");
    expect(calls.review).toBe(1);
    expect(calls.persist).toHaveLength(1);
  });

  test("--ci WRITES but never READS the cache (CI always re-reviews)", async () => {
    const { calls, deps } = harness(requestResult, cachedVerdict);

    const r = await runReviewFlow({ ...deps, ci: true });

    expect(calls.read).toBe(0); // never reads on CI, even though a cache entry exists
    expect(calls.review).toBe(1);
    expect(calls.persist).toHaveLength(1);
    expect(r.cacheHit).toBe(false);
  });
});

describe("read-side + artifact", () => {
  test("honorCachedVerdict drops a cached pre-review block, passes a real verdict through", () => {
    expect(honorCachedVerdict(null)).toBeNull();
    expect(
      honorCachedVerdict({ ...v, blocked: true, preReview: true })
    ).toBeNull();
    expect(honorCachedVerdict(v)).toBe(v);
  });

  test("artifact body is valid JSON carrying verdict + identity + tree hash", () => {
    const body = artifactBody(v, {
      treeHash: "t1",
      panelHash: "p1",
      when: "2026-07-15T00:00:00Z",
    });
    const parsed = JSON.parse(body);

    expect(parsed.verdict.identity).toBe("local/flash");
    expect(parsed.treeHash).toBe("t1");
    expect(parsed.when).toBe("2026-07-15T00:00:00Z");
  });
});
