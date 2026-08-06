import { test, expect, describe } from "bun:test";
import { parseModelsConfig } from "../src/models-config";

const base = {
  active: "local",
  models: {
    local: { baseUrl: "http://x/v1", model: "m" },
    opus: { baseUrl: "http://y/v1", model: "opus" },
  },
};

describe("parseModelsConfig reviewPanel", () => {
  test("parses a model + binary panel", () => {
    const cfg = parseModelsConfig({
      ...base,
      reviewPanel: {
        minReviewers: 2,
        reviewers: [
          { kind: "model", id: "opus", entry: "opus" },
          {
            kind: "binary",
            id: "grok",
            argv: ["grok", "-p"],
            input: "arg",
            timeoutMs: 180000,
            parse: "json-fence",
          },
        ],
      },
    });

    expect(cfg.reviewPanel?.reviewers).toHaveLength(2);
  });

  test("rejects a model reviewer whose entry is not a known model", () => {
    // CHANGED from a throw to a scoped failure. The rejection is the same and
    // the message is the same; what moved is the blast radius. Every command
    // loads this file — /model, capability routing, a plain build — so throwing
    // meant one typo in a REVIEWER stopped all of them starting. The panel is
    // dropped with the reason kept, and harness-review refuses on that rather
    // than running with an empty roster and blaming the endpoint.
    const cfg = parseModelsConfig({
      ...base,
      reviewPanel: {
        minReviewers: 2,
        reviewers: [{ kind: "model", id: "x", entry: "ghost" }],
      },
    });

    expect(cfg.reviewPanel).toBeUndefined();
    expect(cfg.reviewPanelError).toMatch(/entry "ghost"/u);
    // The registry itself is untouched.
    expect(cfg.active).toBe(base.active);
  });

  test("rejects a binary reviewer with an empty argv", () => {
    // Same scoping as above: rejected, reported, and the registry survives.
    const cfg = parseModelsConfig({
      ...base,
      reviewPanel: {
        minReviewers: 2,
        reviewers: [
          {
            kind: "binary",
            id: "b",
            argv: [],
            input: "arg",
            timeoutMs: 1000,
            parse: "raw",
          },
        ],
      },
    });

    expect(cfg.reviewPanel).toBeUndefined();
    expect(cfg.reviewPanelError).toMatch(/argv/u);
    expect(cfg.active).toBe(base.active);
  });

  test("a config with no reviewPanel still parses", () => {
    expect(parseModelsConfig(base).reviewPanel).toBeUndefined();
  });
});
