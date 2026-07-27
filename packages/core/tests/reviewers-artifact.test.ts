import { test, expect, describe } from "bun:test";
import {
  verdictCacheKey,
  artifactBody,
  honorCachedVerdict,
} from "../src/reviewers/harness-review";
import type { IVerdict } from "../src/reviewers/aggregate";

const v: IVerdict = {
  blocked: false,
  reason: "all reviewers approved",
  reviewers: { ok: 2, errored: 0 },
  ranked: [],
  perReviewer: [],
  identity: "local/flash",
};

describe("artifact + cache", () => {
  const key = {
    treeHash: "t1",
    panelHash: "p1",
    rubricVersion: "1",
    cacheVersion: "2",
    base: "main",
    intent: "fix the widget",
    mode: "full",
  };

  test("cache key is stable for the same inputs and changes with the tree hash", () => {
    expect(verdictCacheKey({ ...key })).toBe(verdictCacheKey({ ...key }));
    expect(verdictCacheKey({ ...key })).not.toBe(
      verdictCacheKey({ ...key, treeHash: "t2" })
    );
  });

  test("cacheVersion is mixed into the key — bumping it retires ALL legacy artifacts", () => {
    // CACHE_VERSION is the ONLY thing that retires already-on-disk poisoned v1 blocks
    // (they carry no preReview flag, so the read-side guard can't reject them). If a
    // regression dropped it from the hash, legacy poison would be re-served and every
    // other test would still pass — so pin it here.
    expect(verdictCacheKey({ ...key, cacheVersion: "1" })).not.toBe(
      verdictCacheKey({ ...key, cacheVersion: "2" })
    );
  });

  test("base, intent, and mode each change the key — a verdict can't be reused across a different review request (P4)", () => {
    // The whole request identity, not just the tree, keys the cache: a review vs a
    // different base (different diff), a different intent (different context), or quick
    // vs full (reduced roster) MUST miss the cache and force a fresh review.
    expect(verdictCacheKey({ ...key })).not.toBe(
      verdictCacheKey({ ...key, base: "HEAD~3" })
    );
    expect(verdictCacheKey({ ...key })).not.toBe(
      verdictCacheKey({ ...key, intent: "something else" })
    );
    expect(verdictCacheKey({ ...key, mode: "quick" })).not.toBe(
      verdictCacheKey({ ...key, mode: "full" })
    );
  });

  test("unforgeable key: a space slid between fields can't collide two distinct requests", () => {
    // A space-join would make (base 'a', intent 'b c') and (base 'a b', intent 'c')
    // collide; the JSON serialization keeps them distinct.
    expect(verdictCacheKey({ ...key, base: "a", intent: "b c" })).not.toBe(
      verdictCacheKey({ ...key, base: "a b", intent: "c" })
    );
  });

  test("honorCachedVerdict drops a cached pre-review block, passes a real verdict through", () => {
    // The read-side defense in depth: a pre-review block that somehow reached disk
    // must force a fresh live review (null), while a genuine panel verdict is honored.
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
