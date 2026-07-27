import { test, expect, describe } from "bun:test";
import {
  verdictCacheKey,
  artifactBody,
  honorCachedVerdict,
  resolveReviewInputs,
} from "../src/reviewers/harness-review";
import type { IGitRunner } from "../src/reviewers/harness-review";
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

  // A git runner where `rev-parse <ref>` returns `mainSha` (simulating a moved ref),
  // merge-base returns a fixed sha, and the commit subject is `subject`.
  const gitWith =
    (mainSha: string, subject: string): IGitRunner =>
    async (argv) => {
      if (argv[0] === "rev-parse") {
        return { code: 0, stdout: `${mainSha}\n` };
      }

      if (argv[0] === "merge-base") {
        return { code: 0, stdout: "mergebasesha\n" };
      }

      if (argv[0] === "log") {
        return { code: 0, stdout: `${subject}\n` };
      }

      return { code: 0, stdout: "" };
    };

  test("resolveReviewInputs: a named base ref resolves to a concrete sha → a moved ref changes the key (P4 panel finding)", async () => {
    // `--base main` with `main` moved: same flags, same treeHash, but a DIFFERENT diff.
    // Resolving the ref to a sha makes the key change so it can't reuse the stale verdict.
    const before = await resolveReviewInputs(
      gitWith("sha_A", "fix"),
      "main",
      "fix"
    );
    const after = await resolveReviewInputs(
      gitWith("sha_B", "fix"),
      "main",
      "fix"
    );

    expect(before.baseSha).toBe("sha_A");
    expect(after.baseSha).toBe("sha_B");

    const keyFor = (baseSha: string): string =>
      verdictCacheKey({ ...key, base: baseSha });

    expect(keyFor(before.baseSha)).not.toBe(keyFor(after.baseSha));
  });

  test("resolveReviewInputs: omitted intent falls back to the commit subject (so an amend changes the key)", async () => {
    const a = await resolveReviewInputs(
      gitWith("sha", "first subject"),
      undefined,
      undefined
    );
    const b = await resolveReviewInputs(
      gitWith("sha", "amended subject"),
      undefined,
      undefined
    );

    expect(a.intent).toBe("first subject");
    expect(b.intent).toBe("amended subject");
    expect(a.intent).not.toBe(b.intent);
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
