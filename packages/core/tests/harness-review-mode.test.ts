import { test, expect, describe } from "bun:test";
import { buildReviewFlowDeps } from "../src/cli/harness-review-mode";
import { panelIdentityHash } from "../src/reviewers/harness-review";
import type { IReviewRequest } from "../src/reviewers/schema";
import type { IPanel } from "../src/reviewers/registry";
import type { IVerdict } from "../src/reviewers/aggregate";

/**
 * The CLI wiring (harness-review-mode) is exercised through buildReviewFlowDeps: it must
 * derive the cache key's rosterHash from the EFFECTIVE panel, target the review at the
 * effective panel, map mode/ci from the args, gather with args.base/intent, and thread the
 * effective rosterHash into persistence. A miswire (cfg roster, hardcoded ci, wrong panel)
 * is caught here rather than only in production.
 */

const effective: IPanel = {
  reviewers: [
    {
      kind: "model",
      id: "r1",
      entry: { baseUrl: "http://x/v1", model: "MODEL-X" },
    },
  ],
  minReviewers: 1,
  skipped: [],
};

const request: IReviewRequest = {
  title: "t",
  intent: "t",
  diff: "d",
  validateSummary: { passed: true, failCount: 0, firstErrors: [] },
  contextFiles: [],
  rubricVersion: "1",
};

interface ILog {
  validated: number;
  gitArgs: string[][];
  providerModels: string[];
  readKeys: string[];
  persisted: { key: string; rosterHash: string }[];
}

function makeInput(over: { quick?: boolean; ci?: boolean }) {
  const log: ILog = {
    validated: 0,
    gitArgs: [],
    providerModels: [],
    readKeys: [],
    persisted: [],
  };

  return {
    log,
    input: {
      effective,
      identity: "local/flash",
      quick: over.quick ?? false,
      ci: over.ci ?? false,
      // Distinctive base/intent so a wiring that drops or overrides them is caught.
      base: "customBase",
      intent: "DISTINCT-INTENT",
      git: async (args: string[]) => {
        log.gitArgs.push(args);

        // Enough for gatherChange to build a request: rev-parse/merge-base SHAs, a file +
        // a non-empty diff, readable context. merge-base ECHOES its ref arg so the diff range
        // proves WHICH base was used (a dropped base would echo "main", not "customBase").
        if (args[0] === "rev-parse") {
          return { stdout: "HEADSHA\n", code: 0 };
        }

        if (args[0] === "merge-base") {
          return { stdout: `mb-${String(args[1])}\n`, code: 0 };
        }

        if (args[0] === "diff") {
          return args.includes("--name-only")
            ? { stdout: "x.ts", code: 0 }
            : { stdout: "diff --git a/x b/x\n+code", code: 0 };
        }

        if (args[0] === "show") {
          return { stdout: "content", code: 0 };
        }

        return { stdout: "", code: 0 };
      },
      validate: async () => {
        log.validated += 1;

        return { passed: true, failCount: 0, firstErrors: [] };
      },
      makeProvider: (entry: { model: string }) => {
        log.providerModels.push(entry.model);

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
      readCache: async (key: string) => {
        log.readKeys.push(key);

        return null;
      },
      persistArtifact: async (
        _v: IVerdict,
        key: string,
        rosterHash: string
      ) => {
        log.persisted.push({ key, rosterHash });
      },
    },
  };
}

describe("buildReviewFlowDeps (CLI wiring)", () => {
  test("rosterHash is derived from the EFFECTIVE panel + builder (not the raw config)", () => {
    const { input } = makeInput({});
    const deps = buildReviewFlowDeps(input);

    expect(deps.rosterHash).toBe(panelIdentityHash(effective, "local/flash"));
  });

  test("mode maps from --quick and ci maps from --ci", () => {
    expect(buildReviewFlowDeps(makeInput({ quick: false }).input).mode).toBe(
      "full"
    );
    expect(buildReviewFlowDeps(makeInput({ quick: true }).input).mode).toBe(
      "quick"
    );
    expect(buildReviewFlowDeps(makeInput({ ci: true }).input).ci).toBe(true);
    expect(buildReviewFlowDeps(makeInput({ ci: false }).input).ci).toBe(false);
  });

  test("gather runs validate FRESH and uses args.base + args.intent (a dropped base or frozen intent is caught)", async () => {
    const { log, input } = makeInput({});
    const deps = buildReviewFlowDeps(input);

    const gathered = await deps.gather();

    expect(gathered.kind).toBe("request");
    expect(log.validated).toBe(1); // validate ran inside gather

    if (gathered.kind === "request") {
      // args.intent flowed through (not frozen to some other string).
      expect(gathered.request.intent).toBe("DISTINCT-INTENT");
    }

    // The diff range proves the CONFIGURED base ("customBase") was used — merge-base echoes
    // its ref, so a dropped base would show "mb-main...HEADSHA" and fail this.
    expect(
      log.gitArgs.some((a) => a.join(" ").includes("mb-customBase...HEADSHA"))
    ).toBe(true);
  });

  test("review targets the EFFECTIVE panel (the effective reviewer's model provider is invoked)", async () => {
    const { log, input } = makeInput({});
    const deps = buildReviewFlowDeps(input);

    await deps.review(request);

    expect(log.providerModels).toContain("MODEL-X");
  });

  test("persist carries the EFFECTIVE rosterHash (the artifact records the roster that actually reviewed)", async () => {
    const { log, input } = makeInput({});
    const deps = buildReviewFlowDeps(input);
    const verdict: IVerdict = {
      blocked: false,
      reason: "ok",
      reviewers: { ok: 1, errored: 0 },
      ranked: [],
      perReviewer: [],
      identity: "local/flash",
    };

    await deps.persist(verdict, "KEY");

    expect(log.persisted).toHaveLength(1);
    expect(log.persisted[0]?.key).toBe("KEY");
    expect(log.persisted[0]?.rosterHash).toBe(
      panelIdentityHash(effective, "local/flash")
    );
  });
});
