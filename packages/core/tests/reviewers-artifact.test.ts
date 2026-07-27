import { test, expect, describe } from "bun:test";
import {
  reviewRequestKey,
  panelIdentityHash,
  decideVerdict,
  artifactBody,
  honorCachedVerdict,
} from "../src/reviewers/harness-review";
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

  test("every reviewer-visible dimension changes the key — diff, contextFiles, intent, rubric, roster, mode", () => {
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

  test("a missing contextFiles hashes the same as an explicit empty list (no undefined/[] ambiguity)", () => {
    const { contextFiles: _drop, ...noCtx } = request;

    expect(reviewRequestKey(noCtx, rosterOpts)).toBe(
      reviewRequestKey({ ...noCtx, contextFiles: [] }, rosterOpts)
    );
  });
});

describe("panelIdentityHash (the roster that ACTUALLY reviewed keys the cache)", () => {
  const panel = {
    reviewers: [{ id: "grok" }, { id: "codex" }],
    minReviewers: 2,
  };

  test("stable and order-independent (roster is sorted before hashing)", () => {
    expect(panelIdentityHash(panel, "local/flash")).toBe(
      panelIdentityHash(
        { reviewers: [{ id: "codex" }, { id: "grok" }], minReviewers: 2 },
        "local/flash"
      )
    );
  });

  test("adding/dropping a reviewer, changing the quorum, or changing the builder all change the key", () => {
    const base = panelIdentityHash(panel, "local/flash");

    expect(
      panelIdentityHash(
        { reviewers: [{ id: "grok" }], minReviewers: 2 },
        "local/flash"
      )
    ).not.toBe(base); // a dropped reviewer (effective roster ≠ configured) must not reuse
    expect(
      panelIdentityHash({ ...panel, minReviewers: 1 }, "local/flash")
    ).not.toBe(base);
    expect(panelIdentityHash(panel, "other/model")).not.toBe(base); // different builder
  });
});

describe("decideVerdict (cache orchestration for an already-gathered, already-keyed request)", () => {
  const reviewVerdict: IVerdict = { ...v, reason: "fresh review" };
  const cachedVerdict: IVerdict = { ...v, reason: "from cache" };

  interface ICalls {
    read: number;
    review: number;
    persist: string[];
  }

  const harness = (cached: IVerdict | null) => {
    const calls: ICalls = { read: 0, review: 0, persist: [] };
    const deps = {
      readCache: async (key: string) => {
        calls.read += 1;
        void key;

        return cached;
      },
      review: async () => {
        calls.review += 1;

        return reviewVerdict;
      },
      persist: async (_verdict: IVerdict, key: string) => {
        calls.persist.push(key);
      },
    };

    return { calls, deps };
  };

  test("cache HIT (interactive) reuses the cached verdict — no review, no write", async () => {
    const { calls, deps } = harness(cachedVerdict);

    const r = await decideVerdict(deps, { ci: false, key: "k" });

    expect(r.cacheHit).toBe(true);
    expect(r.verdict.reason).toBe("from cache");
    expect(calls.review).toBe(0);
    expect(calls.persist).toHaveLength(0);
  });

  test("cache MISS runs the review and WRITES under the SAME key", async () => {
    const { calls, deps } = harness(null);

    const r = await decideVerdict(deps, { ci: false, key: "k" });

    expect(r.cacheHit).toBe(false);
    expect(r.verdict.reason).toBe("fresh review");
    expect(calls.review).toBe(1);
    expect(calls.persist).toEqual(["k"]);
  });

  test("--ci WRITES but never READS the cache (CI always re-reviews)", async () => {
    const { calls, deps } = harness(cachedVerdict);

    const r = await decideVerdict(deps, { ci: true, key: "k" });

    expect(calls.read).toBe(0); // never reads on CI, even though a cache entry exists
    expect(calls.review).toBe(1);
    expect(calls.persist).toEqual(["k"]);
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
