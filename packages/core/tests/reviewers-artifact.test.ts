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
  test("cache key is stable for the same inputs and changes with the tree hash", () => {
    const a = verdictCacheKey({
      treeHash: "t1",
      panelHash: "p1",
      rubricVersion: "1",
      cacheVersion: "2",
    });
    const b = verdictCacheKey({
      treeHash: "t1",
      panelHash: "p1",
      rubricVersion: "1",
      cacheVersion: "2",
    });
    const c = verdictCacheKey({
      treeHash: "t2",
      panelHash: "p1",
      rubricVersion: "1",
      cacheVersion: "2",
    });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("cacheVersion is mixed into the key — bumping it retires ALL legacy artifacts", () => {
    // CACHE_VERSION is the ONLY thing that retires already-on-disk poisoned v1 blocks
    // (they carry no preReview flag, so the read-side guard can't reject them). If a
    // regression dropped it from the hash, legacy poison would be re-served and every
    // other test would still pass — so pin it here.
    const base = { treeHash: "t1", panelHash: "p1", rubricVersion: "1" };

    expect(verdictCacheKey({ ...base, cacheVersion: "1" })).not.toBe(
      verdictCacheKey({ ...base, cacheVersion: "2" })
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
