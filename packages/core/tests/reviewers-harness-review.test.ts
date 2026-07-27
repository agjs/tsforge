import { test, expect, describe } from "bun:test";
import {
  gatherChange,
  runHarnessReview,
  shouldCacheVerdict,
  type IGatherDeps,
  type IRunDeps,
} from "../src/reviewers/harness-review";
import type { IPanel } from "../src/reviewers/registry";

function git(map: Record<string, string>): IGatherDeps["git"] {
  return async (args) => {
    const key = args.join(" ");
    const hit = Object.entries(map).find(([k]) => key.includes(k));

    return { stdout: hit?.[1] ?? "", code: 0 };
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

  test("a failing `git diff --name-only` BLOCKS instead of building an empty review (exit code honored)", async () => {
    // The false-green the panel flagged: if git errors and returns empty stdout, an
    // unguarded gather would build a 0-file, empty-diff request that the panel green-lights
    // and caches. Honoring the exit code turns that into a block.
    const failingGit: IGatherDeps["git"] = async (args) =>
      args.includes("--name-only")
        ? { stdout: "", code: 128 }
        : { stdout: "", code: 0 };
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

  test("files listed but an EMPTY content diff (rename/mode-only) → block, not a vacuous cached green", async () => {
    // The false-green the panel flagged: `--name-only` reports a file, but `git diff` exits 0
    // with empty stdout. Without the empty-diff guard a 0-byte review would be built + cached.
    const git2: IGatherDeps["git"] = async (args) => {
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

  test("resolveBase merge-base failure falls back to the ref and still diffs (shallow/odd repos)", async () => {
    // merge-base returns empty (failure); gather must still resolve a range and produce a
    // request rather than throw. Records the range actually diffed.
    const seen: string[] = [];

    const fallbackGit: IGatherDeps["git"] = async (args) => {
      const key = args.join(" ");

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
    // explicit ref given → falls back to that ref (not HEAD~1) for the diff range
    expect(seen.some((k) => k.includes("featureX...HEAD"))).toBe(true);
  });

  test("attaches the changed files' current (HEAD) contents as review context", async () => {
    const deps: IGatherDeps = {
      git: git({
        "diff --name-only": "src/x.ts",
        diff: "diff --git a/src/x.ts b/src/x.ts\n+code",
        "show HEAD:src/x.ts":
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

describe("runHarnessReview", () => {
  test("a blocked gather short-circuits to a blocked verdict without invoking reviewers", async () => {
    let invoked = false;
    const panel: IPanel = { reviewers: [], minReviewers: 2, skipped: [] };
    const deps: IRunDeps = {
      git: git({ "diff --name-only": "x.ts", diff: "+x" }),
      validate: async () => ({
        passed: false,
        failCount: 1,
        firstErrors: ["boom"],
      }),
      makeProvider: () => {
        invoked = true;

        return {
          async complete() {
            return { content: "", toolCalls: [] };
          },
        };
      },
      runBinary: async () => {
        invoked = true;

        return { ok: true, stdout: "" };
      },
      panel,
      identity: "local/flash",
    };
    const v = await runHarnessReview(deps, opts);

    expect(v.blocked).toBe(true);
    expect(invoked).toBe(false);
    // Marked as a PRE-REVIEW gate block so the caller never caches it — a transient
    // validate flake under load must not poison the tree-hash for every later push.
    expect(v.preReview).toBe(true);
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
