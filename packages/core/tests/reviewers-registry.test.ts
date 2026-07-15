import { test, expect, describe } from "bun:test";
import { resolvePanel, MIN_REVIEWERS_FLOOR } from "../src/reviewers/registry";
import type { IModelsConfig } from "../src/models-config";

function cfg(over: Partial<IModelsConfig>): IModelsConfig {
  return {
    active: "local",
    models: {
      local: { baseUrl: "http://host-a/v1", model: "flash" },
      opus: { baseUrl: "http://host-b/v1", model: "opus" },
      cloneAlias: { baseUrl: "http://host-a/v1", model: "flash" },
    },
    ...over,
  };
}

const active = { name: "local", entry: { baseUrl: "http://host-a/v1", model: "flash" } };

describe("resolvePanel independence", () => {
  test("keeps an independent model reviewer", () => {
    const p = resolvePanel(
      cfg({ reviewPanel: { minReviewers: 2, reviewers: [{ kind: "model", id: "opus", entry: "opus" }] } }),
      active
    );

    expect(p.reviewers.map((r) => r.id)).toEqual(["opus"]);
    expect(p.skipped).toEqual([]);
  });

  test("skips the active entry by name", () => {
    const p = resolvePanel(
      cfg({ reviewPanel: { minReviewers: 2, reviewers: [{ kind: "model", id: "self", entry: "local" }] } }),
      active
    );

    expect(p.reviewers).toEqual([]);
    expect(p.skipped[0]?.id).toBe("self");
  });

  test("skips a same-weights alias (same host+model, different entry name)", () => {
    const p = resolvePanel(
      cfg({ reviewPanel: { minReviewers: 2, reviewers: [{ kind: "model", id: "sneaky", entry: "cloneAlias" }] } }),
      active
    );

    expect(p.reviewers).toEqual([]);
    expect(p.skipped[0]?.reason).toMatch(/same model as the builder/u);
  });

  test("binaries are always kept", () => {
    const p = resolvePanel(
      cfg({
        reviewPanel: {
          minReviewers: 2,
          reviewers: [{ kind: "binary", id: "grok", argv: ["grok"], input: "arg", timeoutMs: 1000, parse: "raw" }],
        },
      }),
      active
    );

    expect(p.reviewers.map((r) => r.id)).toEqual(["grok"]);
  });

  test("minReviewers is floored at 2 even if config says 1", () => {
    const p = resolvePanel(
      cfg({ reviewPanel: { minReviewers: 1, reviewers: [{ kind: "model", id: "opus", entry: "opus" }] } }),
      active
    );

    expect(p.minReviewers).toBe(MIN_REVIEWERS_FLOOR);
  });

  test("no panel configured → empty reviewers, floored minReviewers", () => {
    const p = resolvePanel(cfg({}), active);

    expect(p.reviewers).toEqual([]);
    expect(p.minReviewers).toBe(MIN_REVIEWERS_FLOOR);
  });
});
