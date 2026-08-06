import { test, expect, describe } from "bun:test";
import { resolvePanel } from "../src/reviewers/registry";
import type { IModelsConfig, IModelEntry } from "../src/models-config";

/**
 * A binary reviewer is an opaque command — nothing in `argv` says which model
 * answers — so the independence check that skips a MODEL reviewer sharing the
 * builder's host and id could not see one at all. A CLI pointed at the builder's
 * own model counted as an independent vote, and a model agreeing with itself
 * looks exactly like two reviewers agreeing.
 */

const local: IModelEntry = {
  baseUrl: "http://192.168.20.108:8888/v1",
  model: "deepseek-v4-flash-0731",
};
const other: IModelEntry = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-pro",
};

function cfg(
  reviewers: NonNullable<IModelsConfig["reviewPanel"]>["reviewers"]
): IModelsConfig {
  return {
    active: "builder",
    models: { builder: local, elsewhere: other },
    reviewPanel: { minReviewers: 2, reviewers },
  };
}

const binary = {
  kind: "binary" as const,
  id: "cli",
  argv: ["some-cli", "-p"],
  input: "arg" as const,
  timeoutMs: 1000,
  parse: "raw" as const,
};

describe("binary reviewer independence", () => {
  test("a binary fronting the BUILDER's own entry is skipped", () => {
    const panel = resolvePanel(cfg([{ ...binary, fronts: "builder" }]), {
      name: "builder",
      entry: local,
    });

    expect(panel.reviewers).toHaveLength(0);
    expect(panel.skipped[0]?.reason).toContain("active builder");
  });

  test("a binary fronting a DIFFERENT entry with the same host+model is skipped", () => {
    // Same reasoning as the model path: a second name for one model is still one
    // model, and it would otherwise review its own output.
    const twin: IModelEntry = { ...local };
    const panel = resolvePanel(
      {
        active: "builder",
        models: { builder: local, twin },
        reviewPanel: {
          minReviewers: 2,
          reviewers: [{ ...binary, fronts: "twin" }],
        },
      },
      { name: "builder", entry: local }
    );

    expect(panel.reviewers).toHaveLength(0);
    expect(panel.skipped[0]?.reason).toContain("same model as the builder");
  });

  test("a binary fronting an independent model is kept", () => {
    const panel = resolvePanel(cfg([{ ...binary, fronts: "elsewhere" }]), {
      name: "builder",
      entry: local,
    });

    expect(panel.reviewers).toHaveLength(1);
  });

  test("a binary naming an unknown entry is skipped, not silently trusted", () => {
    const panel = resolvePanel(cfg([{ ...binary, fronts: "nope" }]), {
      name: "builder",
      entry: local,
    });

    expect(panel.reviewers).toHaveLength(0);
    expect(panel.skipped[0]?.reason).toContain("not in models");
  });

  test("an UNDECLARED binary is still kept", () => {
    // There is nothing to compare it against, and refusing every CLI that has
    // not been annotated would disable working panels for a risk that may not
    // exist. Its independence is then the config author's claim, not ours.
    const panel = resolvePanel(cfg([binary]), {
      name: "builder",
      entry: local,
    });

    expect(panel.reviewers).toHaveLength(1);
  });
});
