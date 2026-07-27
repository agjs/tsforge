import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import {
  verdictCacheKey,
  artifactBody,
  honorCachedVerdict,
  resolveReviewInputs,
  reviewPlan,
  CACHE_VERSION,
} from "../src/reviewers/harness-review";
import { RUBRIC_VERSION } from "../src/reviewers/schema";
import type {
  IGitRunner,
  IResolvedReviewInputs,
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
    diffHash: "d1",
    panelHash: "p1",
    rubricVersion: "1",
    cacheVersion: "2",
    intent: "fix the widget",
    mode: "full",
  };

  test("cache key is stable for the same inputs and changes with the reviewed-diff hash", () => {
    expect(verdictCacheKey({ ...key })).toBe(verdictCacheKey({ ...key }));
    expect(verdictCacheKey({ ...key })).not.toBe(
      verdictCacheKey({ ...key, diffHash: "d2" })
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

  test("diffHash, intent, and mode each change the key — a verdict can't be reused across a different review request (P4)", () => {
    // The whole request identity keys the cache: a different reviewed diff (different
    // diffHash), a different intent (different context), or quick vs full (reduced roster)
    // MUST miss the cache and force a fresh review.
    expect(verdictCacheKey({ ...key })).not.toBe(
      verdictCacheKey({ ...key, diffHash: "other-diff" })
    );
    expect(verdictCacheKey({ ...key })).not.toBe(
      verdictCacheKey({ ...key, intent: "something else" })
    );
    expect(verdictCacheKey({ ...key, mode: "quick" })).not.toBe(
      verdictCacheKey({ ...key, mode: "full" })
    );
  });

  test("unforgeable key: a space slid between fields can't collide two distinct requests", () => {
    // A space-join would make (diffHash 'a', intent 'b c') and (diffHash 'a b', intent 'c')
    // collide; the JSON serialization keeps them distinct.
    expect(verdictCacheKey({ ...key, diffHash: "a", intent: "b c" })).not.toBe(
      verdictCacheKey({ ...key, diffHash: "a b", intent: "c" })
    );
  });

  // A git runner scripted per command. `diff` returns `diffOut` (with `diffCode`), the
  // commit subject is `subject`. It also RECORDS the argv of every `git diff` it served so
  // a test can assert WHICH range was hashed.
  const gitScript = (opts: {
    diffOut: string;
    diffCode?: number;
    subject?: string;
    seenDiffArgs?: string[][];
  }): IGitRunner => {
    return async (argv) => {
      if (argv[0] === "diff") {
        opts.seenDiffArgs?.push(argv);

        return { code: opts.diffCode ?? 0, stdout: opts.diffOut };
      }

      if (argv[0] === "merge-base") {
        return { code: 0, stdout: "mergebasesha\n" };
      }

      if (argv[0] === "log") {
        return { code: 0, stdout: `${opts.subject ?? "a subject"}\n` };
      }

      return { code: 0, stdout: "" };
    };
  };

  test("resolveReviewInputs hashes the ACTUAL `${base}...HEAD` diff and returns the same base for the review", async () => {
    // The invariant that makes key and review inseparable: the hash is taken over exactly
    // the range the review will diff, and the SAME base is returned to hand to the review.
    const seen: string[][] = [];
    const r = await resolveReviewInputs(
      gitScript({ diffOut: "some diff", seenDiffArgs: seen, subject: "fix" }),
      "main",
      "fix"
    );

    expect(seen).toContainEqual(["diff", "main...HEAD"]);
    expect(r.base).toBe("main");
    expect(r.diffHash).toBe(
      createHash("sha256").update("some diff").digest("hex")
    );
  });

  test("resolveReviewInputs: a rebase that changes the diff — same base ref, same subject, same tree — changes the key (P4 three-dot merge-base finding)", async () => {
    // `--base main` with `main`, the subject, and the final tree ALL unchanged, but a
    // rebase shifted merge-base(main, HEAD) so `main...HEAD` now yields a DIFFERENT diff.
    // Keying on a base sha would collide here; hashing the diff bytes does not.
    const before = await resolveReviewInputs(
      gitScript({ diffOut: "diff BEFORE rebase", subject: "fix" }),
      "main",
      "fix"
    );
    const after = await resolveReviewInputs(
      gitScript({ diffOut: "diff AFTER rebase", subject: "fix" }),
      "main",
      "fix"
    );

    // Same named ref, but the reviewed diff (and thus its fingerprint) differs — which the
    // "diffHash changes the key" test above proves yields a different cache key.
    expect(before.base).toBe(after.base);
    expect(before.diffHash).not.toBeNull();
    expect(before.diffHash).not.toBe(after.diffHash);
  });

  test("resolveReviewInputs: a git diff failure yields diffHash null (caller MUST skip the cache, never fall back to the movable ref)", async () => {
    const r = await resolveReviewInputs(
      gitScript({ diffOut: "", diffCode: 128, subject: "fix" }),
      "main",
      "fix"
    );

    expect(r.diffHash).toBeNull();
  });

  test("resolveReviewInputs: omitted intent falls back to the commit subject (so an amend changes the key)", async () => {
    const a = await resolveReviewInputs(
      gitScript({ diffOut: "d", subject: "first subject" }),
      undefined,
      undefined
    );
    const b = await resolveReviewInputs(
      gitScript({ diffOut: "d", subject: "amended subject" }),
      undefined,
      undefined
    );

    expect(a.intent).toBe("first subject");
    expect(b.intent).toBe("amended subject");
    expect(a.intent).not.toBe(b.intent);
  });

  const resolvedInputs = (
    over: Partial<IResolvedReviewInputs>
  ): IResolvedReviewInputs => ({
    base: "main",
    intent: "fix the widget",
    diffHash: "d1",
    ...over,
  });

  test("reviewPlan binds the cache key AND the review request to the SAME resolved inputs (the review can't diverge from the key — CI-parity)", () => {
    // The wiring guarantee the panel demanded: the base/intent the key fingerprints are the
    // exact base/intent handed to the review. There is no separate raw-flag path.
    const resolved = resolvedInputs({ base: "abc123", intent: "do a thing" });
    const plan = reviewPlan(resolved, { quick: false, panelHash: "p1" });

    expect(plan.reviewBase).toBe(resolved.base);
    expect(plan.reviewIntent).toBe(resolved.intent ?? undefined);
    // The key is the same one verdictCacheKey would produce for these resolved inputs.
    expect(plan.cacheKey).toBe(
      verdictCacheKey({
        diffHash: "d1",
        panelHash: "p1",
        rubricVersion: RUBRIC_VERSION,
        cacheVersion: CACHE_VERSION,
        intent: "do a thing",
        mode: "full",
      })
    );
  });

  test("reviewPlan: quick mode keys and reviews as 'quick' (reduced roster can't satisfy a full review)", () => {
    const resolved = resolvedInputs({});
    const full = reviewPlan(resolved, { quick: false, panelHash: "p1" });
    const quick = reviewPlan(resolved, { quick: true, panelHash: "p1" });

    expect(quick.cacheKey).not.toBe(full.cacheKey);
  });

  test("reviewPlan: a null diffHash yields a null cacheKey — caller neither reads nor writes the cache (git-failure fail-safe), but STILL reviews (base/intent set)", () => {
    const plan = reviewPlan(resolvedInputs({ diffHash: null }), {
      quick: false,
      panelHash: "p1",
    });

    expect(plan.cacheKey).toBeNull();
    expect(plan.reviewBase).toBe("main");
    expect(plan.reviewIntent).toBe("fix the widget");
  });

  test("reviewPlan: a null intent is passed to the review as undefined (not the string 'null')", () => {
    const plan = reviewPlan(resolvedInputs({ intent: null }), {
      quick: false,
      panelHash: "p1",
    });

    expect(plan.reviewIntent).toBeUndefined();
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
