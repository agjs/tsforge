import { test, expect, describe } from "bun:test";
import {
  gatherChange,
  runHarnessReview,
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
  });
});
