import { test, expect, describe } from "bun:test";
import {
  gatherChange,
  reviewRequest,
  shouldCacheVerdict,
  type IGatherDeps,
} from "../src/reviewers/harness-review";
import type { IPanel } from "../src/reviewers/registry";

function git(map: Record<string, string>): IGatherDeps["git"] {
  return async (args) => {
    const key = args.join(" ");
    const hit = Object.entries(map).find(([k]) => key.includes(k));

    if (hit) {
      return { stdout: hit[1], code: 0 };
    }

    // Defaults so the HEAD pin + base resolve to SHAs unless a test overrides them (the pin
    // now REQUIRES a real SHA — an empty rev-parse would block).
    if (args[0] === "rev-parse") {
      return { stdout: "HEADSHA", code: 0 };
    }

    if (args[0] === "merge-base") {
      return { stdout: "MBSHA", code: 0 };
    }

    return { stdout: "", code: 0 };
  };
}

const cleanValidate = async () => ({
  passed: true,
  failCount: 0,
  firstErrors: [],
});
const opts = { maxFiles: 40, maxChars: 120000, intent: "add feature X" };

describe("gatherChange", () => {
  test("validate red → block, panel not needed", async () => {
    const deps: IGatherDeps = {
      git: git({
        diff: "diff --git a/x b/x\n+code",
        "diff --name-only": "x.ts",
      }),
      validate: async () => ({
        passed: false,
        failCount: 3,
        firstErrors: ["TS2345 ..."],
      }),
    };
    const r = await gatherChange(deps, opts);

    expect(r.kind).toBe("block");

    if (r.kind === "block") {
      expect(r.reason).toMatch(/validate/iu);
    }
  });

  test("no intent and a generic commit subject → block asking for --intent", async () => {
    const deps: IGatherDeps = {
      git: git({ "diff --name-only": "x.ts", diff: "+x", "log -1": "wip" }),
      validate: cleanValidate,
    };
    const r = await gatherChange(deps, { maxFiles: 40, maxChars: 120000 });

    expect(r.kind).toBe("block");

    if (r.kind === "block") {
      expect(r.reason).toMatch(/intent/iu);
    }
  });

  test("over the file budget → block asking to split", async () => {
    const names = Array.from({ length: 50 }, (_, i) => `f${String(i)}.ts`).join(
      "\n"
    );
    const deps: IGatherDeps = {
      git: git({ "diff --name-only": names, diff: "+x" }),
      validate: cleanValidate,
    };
    const r = await gatherChange(deps, opts);

    expect(r.kind).toBe("block");

    if (r.kind === "block") {
      expect(r.reason).toMatch(/split/iu);
    }
  });

  test("clean small change with intent → a request", async () => {
    const deps: IGatherDeps = {
      git: git({
        "diff --name-only": "x.ts",
        diff: "diff --git a/x b/x\n+code",
      }),
      validate: cleanValidate,
    };
    const r = await gatherChange(deps, opts);

    expect(r.kind).toBe("request");

    if (r.kind === "request") {
      expect(r.request.intent).toBe("add feature X");
      expect(r.request.validateSummary.passed).toBe(true);
    }
  });

  test("a failing `git rev-parse HEAD` BLOCKS (no soft fallback to a moving HEAD ref)", async () => {
    // The pin must be honest: on rev-parse failure, block — do NOT silently review the movable
    // "HEAD" ref (which would re-open the TOCTOU the pin exists to close).
    const failingHead: IGatherDeps["git"] = async (args) =>
      args[0] === "rev-parse"
        ? { stdout: "", code: 128 }
        : { stdout: "", code: 0 };
    const r = await gatherChange(
      { git: failingHead, validate: cleanValidate },
      opts
    );

    expect(r.kind).toBe("block");

    if (r.kind === "block") {
      expect(r.reason).toMatch(/could not resolve HEAD/iu);
    }
  });

  test("a failing `git diff --name-only` BLOCKS instead of building an empty review (exit code honored)", async () => {
    // The false-green the panel flagged: if git errors and returns empty stdout, an
    // unguarded gather would build a 0-file, empty-diff request that the panel green-lights
    // and caches. Honoring the exit code turns that into a block.
    const failingGit: IGatherDeps["git"] = async (args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "HEADSHA", code: 0 };
      }

      if (args[0] === "merge-base") {
        return { stdout: "MBSHA", code: 0 };
      }

      return args.includes("--name-only")
        ? { stdout: "", code: 128 }
        : { stdout: "", code: 0 };
    };

    const r = await gatherChange(
      { git: failingGit, validate: cleanValidate },
      opts
    );

    expect(r.kind).toBe("block");

    if (r.kind === "block") {
      expect(r.reason).toMatch(/could not compute the changed-file list/iu);
    }
  });

  test("a failing `git diff` (content) BLOCKS even when the name list succeeded", async () => {
    const git2: IGatherDeps["git"] = async (args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "HEADSHA", code: 0 };
      }

      if (args[0] === "merge-base") {
        return { stdout: "MBSHA", code: 0 };
      }

      if (args.includes("--name-only")) {
        return { stdout: "x.ts", code: 0 };
      }

      if (args[0] === "diff") {
        return { stdout: "", code: 129 }; // the content diff fails
      }

      return { stdout: "", code: 0 };
    };

    const r = await gatherChange({ git: git2, validate: cleanValidate }, opts);

    expect(r.kind).toBe("block");

    if (r.kind === "block") {
      expect(r.reason).toMatch(/could not compute the diff/iu);
    }
  });

  test("files listed but an EMPTY content diff → block (defense in depth), not a vacuous cached green", async () => {
    // `--name-only` reports a file, but the content `git diff` exits 0 with empty stdout — a
    // git anomaly / name-only↔diff disagreement (a REAL rename/mode change is non-empty). The
    // guard blocks it rather than build+cache a 0-byte review the panel would green-light.
    const git2: IGatherDeps["git"] = async (args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "HEADSHA", code: 0 };
      }

      if (args[0] === "merge-base") {
        return { stdout: "MBSHA", code: 0 };
      }

      if (args.includes("--name-only")) {
        return { stdout: "renamed.ts", code: 0 };
      }

      if (args[0] === "diff") {
        return { stdout: "", code: 0 }; // exit 0, but empty content
      }

      return { stdout: "", code: 0 };
    };

    const r = await gatherChange({ git: git2, validate: cleanValidate }, opts);

    expect(r.kind).toBe("block");

    if (r.kind === "block") {
      expect(r.reason).toMatch(/empty/iu);
    }
  });

  test("no changed files between base and HEAD → block (nothing to review, never a vacuous green)", async () => {
    const deps: IGatherDeps = {
      git: git({ "diff --name-only": "", diff: "" }),
      validate: cleanValidate,
    };
    const r = await gatherChange(deps, opts);

    expect(r.kind).toBe("block");

    if (r.kind === "block") {
      expect(r.reason).toMatch(/no changes/iu);
    }
  });

  test("resolveBase SUCCESS path: diffs merge-base-SHA...HEAD-SHA (both pinned to immutable commits, not movable refs)", async () => {
    // The happy path the panel flagged as untested: merge-base returns a real SHA and HEAD is
    // pinned via rev-parse, so every read is against one snapshot. Deleting the pin would make
    // this fail (the range would reference `main`/`HEAD` refs, not the SHAs).
    const seen: string[] = [];

    const pinnedGit: IGatherDeps["git"] = async (args) => {
      const key = args.join(" ");

      if (args[0] === "rev-parse") {
        return { stdout: "HEADSHA\n", code: 0 };
      }

      if (args[0] === "merge-base") {
        return { stdout: "MBSHA\n", code: 0 };
      }

      if (args[0] === "diff") {
        seen.push(key);

        return key.includes("--name-only")
          ? { stdout: "x.ts", code: 0 }
          : { stdout: "diff --git a/x b/x\n+code", code: 0 };
      }

      if (args[0] === "show") {
        seen.push(key);

        return { stdout: "file content", code: 0 };
      }

      return { stdout: "", code: 0 };
    };

    const r = await gatherChange(
      { git: pinnedGit, validate: cleanValidate },
      { ...opts, base: "main" }
    );

    expect(r.kind).toBe("request");
    // The diff range and the context `show` both reference the pinned SHAs.
    expect(seen.some((k) => k.includes("MBSHA...HEADSHA"))).toBe(true);
    expect(seen.some((k) => k.includes("show HEADSHA:x.ts"))).toBe(true);
  });

  test("resolveBase merge-base failure falls back to the ref resolved to a SHA (shallow/odd repos), still one snapshot", async () => {
    // merge-base fails; the fallback base must be PINNED (rev-parse'd to a SHA), NOT the movable
    // ref — else the name-only/content diffs could observe different commits mid-gather. Prove
    // the range is <baseSHA>...<headSHA>, both immutable.
    const seen: string[] = [];

    const fallbackGit: IGatherDeps["git"] = async (args) => {
      const key = args.join(" ");

      if (args[0] === "rev-parse") {
        // HEAD → HEADSHA; the fallback base ref "featureX" → FEATURESHA.
        return args[1] === "HEAD"
          ? { stdout: "HEADSHA", code: 0 }
          : { stdout: "FEATURESHA", code: 0 };
      }

      if (args[0] === "merge-base") {
        return { stdout: "", code: 1 }; // no merge-base
      }

      if (args[0] === "diff") {
        seen.push(key);

        return key.includes("--name-only")
          ? { stdout: "x.ts", code: 0 }
          : { stdout: "diff --git a/x b/x\n+code", code: 0 };
      }

      return { stdout: "", code: 0 };
    };

    const r = await gatherChange(
      { git: fallbackGit, validate: cleanValidate },
      { ...opts, base: "featureX" }
    );

    expect(r.kind).toBe("request");
    // Both ends are pinned SHAs — a moving ref would have shown "featureX...HEAD" (and would
    // still pass on a broken pin), which this now rejects.
    expect(seen.some((k) => k.includes("FEATURESHA...HEADSHA"))).toBe(true);
  });

  test("a merge-base failure whose fallback ref ALSO can't be pinned BLOCKS (never diff a movable ref)", async () => {
    const unpinnable: IGatherDeps["git"] = async (args) => {
      if (args[0] === "rev-parse") {
        // HEAD pins, but the fallback base ref cannot be resolved.
        return args[1] === "HEAD"
          ? { stdout: "HEADSHA", code: 0 }
          : { stdout: "", code: 128 };
      }

      if (args[0] === "merge-base") {
        return { stdout: "", code: 1 };
      }

      return { stdout: "", code: 0 };
    };

    const r = await gatherChange(
      { git: unpinnable, validate: cleanValidate },
      { ...opts, base: "ghost" }
    );

    expect(r.kind).toBe("block");

    if (r.kind === "block") {
      expect(r.reason).toMatch(/could not resolve the diff base/iu);
    }
  });

  test("rev-parse HEAD succeeds but returns EMPTY stdout → still BLOCKS (an empty SHA is not a valid pin)", async () => {
    // The subtle soft-fallback the panel flagged: code 0 + empty output must NOT become the
    // movable "HEAD" ref. It blocks like a hard rev-parse failure.
    const emptyHead: IGatherDeps["git"] = async (args) =>
      args[0] === "rev-parse"
        ? { stdout: "\n", code: 0 }
        : { stdout: "", code: 0 };
    const r = await gatherChange(
      { git: emptyHead, validate: cleanValidate },
      opts
    );

    expect(r.kind).toBe("block");

    if (r.kind === "block") {
      expect(r.reason).toMatch(/could not resolve HEAD/iu);
    }
  });

  test("attaches the changed files' current (HEAD) contents as review context", async () => {
    const deps: IGatherDeps = {
      git: git({
        "diff --name-only": "src/x.ts",
        diff: "diff --git a/src/x.ts b/src/x.ts\n+code",
        // head is pinned to a SHA (default HEADSHA), so context reads `show <sha>:file`.
        "show HEADSHA:src/x.ts":
          "export function realCode(): number {\n  return 42;\n}",
      }),
      validate: cleanValidate,
    };
    const r = await gatherChange(deps, opts);

    expect(r.kind).toBe("request");

    if (r.kind === "request") {
      const ctx = (r.request.contextFiles ?? []).join("\n");

      expect(ctx).toContain("=== src/x.ts ===");
      expect(ctx).toContain("realCode"); // the reviewer sees the WHOLE file, not just the hunk
    }
  });
});

describe("reviewRequest (success path: invoke the panel on a gathered request → aggregate)", () => {
  test("invokes the reviewers and returns their aggregated verdict", async () => {
    const request = {
      title: "add x",
      intent: "add x",
      diff: "diff --git a/x b/x\n+code",
      validateSummary: { passed: true, failCount: 0, firstErrors: [] },
      contextFiles: [],
      rubricVersion: "1",
    };
    // A single approving model reviewer; aggregate should return an unblocked verdict.
    const panel: IPanel = {
      reviewers: [
        {
          kind: "model",
          id: "r1",
          entry: { baseUrl: "http://x/v1", model: "m" },
        },
      ],
      minReviewers: 1,
      skipped: [],
    };
    let invoked = 0;
    const v = await reviewRequest(request, {
      makeProvider: () => {
        invoked += 1;

        return {
          async complete() {
            return {
              content: '{"decision":"approve","findings":[]}',
              toolCalls: [],
            };
          },
        };
      },
      runBinary: async () => ({ ok: true, stdout: "" }),
      panel,
      identity: "local/flash",
    });

    expect(invoked).toBe(1); // the panel actually ran (not short-circuited)
    expect(v.identity).toBe("local/flash");
    expect(v.preReview).not.toBe(true); // a real panel verdict, cacheable
  });
});

describe("shouldCacheVerdict", () => {
  const base = {
    reason: "",
    reviewers: { ok: 2, errored: 0 },
    ranked: [],
    perReviewer: [],
    identity: "local/flash",
  };

  test("a pre-review gate block is NOT cached (preReview true → false)", () => {
    // The whole cache-poison fix: a transient validate/precondition block must not be
    // persisted, or a flake under load blocks every later push of that tree.
    expect(
      shouldCacheVerdict({ ...base, blocked: true, preReview: true })
    ).toBe(false);
  });

  test("a REAL panel verdict IS cached — both a clean pass and a findings block", () => {
    // The expensive panel result must be cached; only the pre-review shape is skipped.
    expect(shouldCacheVerdict({ ...base, blocked: false })).toBe(true);
    expect(shouldCacheVerdict({ ...base, blocked: true })).toBe(true);
  });
});
