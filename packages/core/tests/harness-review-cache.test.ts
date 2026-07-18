import { test, expect, describe } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistVerdict } from "../src/cli/harness-review-mode";
import type { IVerdict } from "../src/reviewers/aggregate";

const real: IVerdict = {
  blocked: false,
  reason: "all reviewers approved",
  reviewers: { ok: 2, errored: 0 },
  ranked: [],
  perReviewer: [],
  identity: "local/flash",
};

const preReviewBlock: IVerdict = {
  blocked: true,
  reason: "validate failed (10 errors)",
  reviewers: { ok: 0, errored: 0 },
  ranked: [],
  perReviewer: [],
  identity: "local/flash",
  preReview: true,
};

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hr-cache-"));

  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("persistVerdict (cache-poison guard at the write site)", () => {
  test("a PRE-REVIEW gate block writes NO cache artifact", async () => {
    await withTempDir(async (dir) => {
      await persistVerdict(preReviewBlock, "key1", "t1", "p1", dir);

      // The exact regression: a transient validate block must never reach disk, or
      // it re-serves as a permanent block for that tree. Prove the file is absent —
      // this catches an omitted/inverted guard the pure predicate test cannot.
      const files = await readdir(dir).catch(() => []);

      expect(files).toHaveLength(0);
    });
  });

  test("a REAL panel verdict IS written as a cache artifact", async () => {
    await withTempDir(async (dir) => {
      await persistVerdict(real, "key1", "t1", "p1", dir);
      const files = await readdir(dir);

      expect(files).toEqual(["key1.json"]);
    });
  });
});
