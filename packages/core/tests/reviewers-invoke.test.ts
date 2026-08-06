import { test, expect, describe } from "bun:test";
import { reviewerInvoke, type IInvokeDeps } from "../src/reviewers/invoke";
import type { IPanel } from "../src/reviewers/registry";
import type { IReviewRequest } from "../src/reviewers/schema";
import type { IProvider } from "../src/inference";

const request: IReviewRequest = {
  title: "t",
  intent: "i",
  diff: "d",
  validateSummary: { passed: true, failCount: 0, firstErrors: [] },
  rubricVersion: "1",
};

function jsonProvider(body: unknown): IProvider {
  return {
    async complete() {
      return { content: JSON.stringify(body), toolCalls: [] };
    },
  };
}

function panelWith(...reviewers: IPanel["reviewers"]): IPanel {
  return { reviewers, minReviewers: 2, skipped: [] };
}

describe("reviewerInvoke", () => {
  test("a model reviewer returning valid JSON → ok outcome", async () => {
    const deps: IInvokeDeps = {
      makeProvider: () =>
        jsonProvider({ verdict: "approve", summary: "", findings: [] }),
      runBinary: async () => ({
        ok: true,
        stdout: "",
        timedOut: false,
        truncated: false,
        stoppedBy: "eof" as const,
      }),
    };
    const out = await reviewerInvoke(
      panelWith({
        kind: "model",
        id: "opus",
        entry: { baseUrl: "http://x/v1", model: "m" },
      }),
      request,
      deps
    );

    expect(out[0]?.status).toBe("ok");
  });

  test("a reviewer that throws → errored (others still returned)", async () => {
    const throwing: IProvider = {
      async complete() {
        throw new Error("boom");
      },
    };
    const deps: IInvokeDeps = {
      makeProvider: (e) =>
        e.model === "bad"
          ? throwing
          : jsonProvider({ verdict: "approve", summary: "", findings: [] }),
      runBinary: async () => ({
        ok: true,
        stdout: "",
        timedOut: false,
        truncated: false,
        stoppedBy: "eof" as const,
      }),
    };
    const out = await reviewerInvoke(
      panelWith(
        {
          kind: "model",
          id: "bad",
          entry: { baseUrl: "http://x/v1", model: "bad" },
        },
        {
          kind: "model",
          id: "good",
          entry: { baseUrl: "http://y/v1", model: "good" },
        }
      ),
      request,
      deps
    );
    const byId = Object.fromEntries(
      out.map((o) => [
        o.status === "ok" ? o.review.reviewerId : o.reviewerId,
        o.status,
      ])
    );

    expect(byId.bad).toBe("errored");
    expect(byId.good).toBe("ok");
  });

  test("malformed JSON from a reviewer → errored, not a silent approve", async () => {
    const deps: IInvokeDeps = {
      makeProvider: () => ({
        async complete() {
          return { content: "not json", toolCalls: [] };
        },
      }),
      runBinary: async () => ({
        ok: true,
        stdout: "",
        timedOut: false,
        truncated: false,
        stoppedBy: "eof" as const,
      }),
    };
    const out = await reviewerInvoke(
      panelWith({
        kind: "model",
        id: "m",
        entry: { baseUrl: "http://x/v1", model: "m" },
      }),
      request,
      deps
    );

    expect(out[0]?.status).toBe("errored");
  });

  test("a binary reviewer: json-fence output is parsed", async () => {
    const fenced =
      'reasoning...\n```json\n{"verdict":"reject","summary":"no","findings":[]}\n```\n';
    const deps: IInvokeDeps = {
      makeProvider: () => jsonProvider({}),
      runBinary: async () => ({
        ok: true,
        stdout: fenced,
        timedOut: false,
        truncated: false,
        stoppedBy: "eof" as const,
      }),
    };
    const out = await reviewerInvoke(
      panelWith({
        kind: "binary",
        id: "grok",
        argv: ["grok"],
        input: "arg",
        timeoutMs: 1000,
        parse: "json-fence",
      }),
      request,
      deps
    );

    // toMatchObject, not toEqual: every outcome also carries `ms` (how long the
    // reviewer took), which is a live clock and not what this test is about.
    expect(out[0]).toMatchObject({
      status: "ok",
      review: {
        reviewerId: "grok",
        verdict: "reject",
        findings: [],
        summary: "no",
      },
    });
  });

  test("a binary that exits non-zero → errored", async () => {
    const deps: IInvokeDeps = {
      makeProvider: () => jsonProvider({}),
      runBinary: async () => ({
        ok: false,
        stdout: "",
        timedOut: false,
        truncated: false,
        stoppedBy: "eof" as const,
      }),
    };
    const out = await reviewerInvoke(
      panelWith({
        kind: "binary",
        id: "grok",
        argv: ["grok"],
        input: "arg",
        timeoutMs: 1000,
        parse: "raw",
      }),
      request,
      deps
    );

    expect(out[0]?.status).toBe("errored");
  });

  test("a binary reviewer receives the review contract (system prompt) in its prompt, not just the request", async () => {
    // Binaries (e.g. grok) have no separate system channel; if the JSON-schema +
    // reject-by-default contract isn't prepended, the binary emits prose and is
    // always errored — silently breaking the headline binary reviewer.
    let seen = "";
    const deps: IInvokeDeps = {
      makeProvider: () => jsonProvider({}),
      runBinary: async (_r, stdin) => {
        seen = stdin;

        return {
          ok: true,
          stdout: '{"verdict":"approve","summary":"","findings":[]}',
          timedOut: false,
          truncated: false,
          stoppedBy: "eof" as const,
        };
      },
    };
    const out = await reviewerInvoke(
      panelWith({
        kind: "binary",
        id: "grok",
        argv: ["grok"],
        input: "arg",
        timeoutMs: 1000,
        parse: "raw",
      }),
      request,
      deps
    );

    expect(out[0]?.status).toBe("ok");
    expect(seen).toContain("independent, skeptical code reviewer");
    expect(seen).toContain("House rules");
    expect(seen).toContain(request.diff);
  });
});
