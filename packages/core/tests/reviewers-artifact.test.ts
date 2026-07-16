import { test, expect, describe } from "bun:test";
import { verdictCacheKey, artifactBody } from "../src/reviewers/harness-review";
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
    });
    const b = verdictCacheKey({
      treeHash: "t1",
      panelHash: "p1",
      rubricVersion: "1",
    });
    const c = verdictCacheKey({
      treeHash: "t2",
      panelHash: "p1",
      rubricVersion: "1",
    });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
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
