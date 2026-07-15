import { test, expect, describe } from "bun:test";
import { parseModelsConfig } from "../src/models-config";

const base = {
  active: "local",
  models: { local: { baseUrl: "http://x/v1", model: "m" }, opus: { baseUrl: "http://y/v1", model: "opus" } },
};

describe("parseModelsConfig reviewPanel", () => {
  test("parses a model + binary panel", () => {
    const cfg = parseModelsConfig({
      ...base,
      reviewPanel: {
        minReviewers: 2,
        reviewers: [
          { kind: "model", id: "opus", entry: "opus" },
          { kind: "binary", id: "grok", argv: ["grok", "-p"], input: "arg", timeoutMs: 180000, parse: "json-fence" },
        ],
      },
    });

    expect(cfg.reviewPanel?.reviewers).toHaveLength(2);
  });

  test("rejects a model reviewer whose entry is not a known model", () => {
    expect(() =>
      parseModelsConfig({
        ...base,
        reviewPanel: { minReviewers: 2, reviewers: [{ kind: "model", id: "x", entry: "ghost" }] },
      })
    ).toThrow(/entry "ghost"/u);
  });

  test("rejects a binary reviewer with an empty argv", () => {
    expect(() =>
      parseModelsConfig({
        ...base,
        reviewPanel: {
          minReviewers: 2,
          reviewers: [{ kind: "binary", id: "b", argv: [], input: "arg", timeoutMs: 1000, parse: "raw" }],
        },
      })
    ).toThrow(/argv/u);
  });

  test("a config with no reviewPanel still parses", () => {
    expect(parseModelsConfig(base).reviewPanel).toBeUndefined();
  });
});
