import { test, expect, describe } from "bun:test";
import { resolvePanel } from "../src/reviewers/registry";
import { parseModelsConfig } from "../src/models-config";
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

describe("parsing the fronts declaration", () => {
  /**
   * The half a resolvePanel test cannot reach. `fronts` arrives from JSON, and
   * how the parser treats a wrong one decides whether a typo becomes an
   * unchecked reviewer.
   */
  const base = {
    active: "builder",
    models: { builder: { baseUrl: "http://x/v1", model: "m" } },
  };
  const withFronts = (fronts: unknown): unknown => ({
    ...base,
    reviewPanel: {
      minReviewers: 2,
      reviewers: [
        {
          kind: "binary",
          id: "cli",
          argv: ["cli"],
          input: "arg",
          timeoutMs: 1000,
          parse: "raw",
          ...(fronts === undefined ? {} : { fronts }),
        },
      ],
    },
  });

  test("a string declaration survives the parse", () => {
    const cfg = parseModelsConfig(withFronts("builder"));
    const first = cfg.reviewPanel?.reviewers[0];

    expect(first?.kind === "binary" && first.fronts).toBe("builder");
  });

  test("no declaration parses to no field", () => {
    const cfg = parseModelsConfig(withFronts(undefined));
    const first = cfg.reviewPanel?.reviewers[0];

    expect(first?.kind === "binary" && first.fronts).toBeUndefined();
  });

  test("a NON-STRING declaration is rejected, not silently dropped", () => {
    // The failure this field exists to remove, reintroduced one level up:
    // dropping a typo means the author believes they declared independence
    // while the binary takes the undeclared path and votes anyway.
    for (const bad of [123, true, null, ["builder"], {}, ""]) {
      expect(() => parseModelsConfig(withFronts(bad))).toThrow(/fronts/);
    }
  });
});

describe("entry lookup is own-properties only", () => {
  test("a binary fronting an inherited name is skipped, not resolved", () => {
    // `models["constructor"]` on a plain object literal resolves to an inherited
    // FUNCTION rather than undefined, so the "not in models" skip never fires
    // and the independence check receives something that is not a model.
    for (const name of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
    ]) {
      const panel = resolvePanel(cfg([{ ...binary, fronts: name }]), {
        name: "builder",
        entry: local,
      });

      expect(panel.reviewers).toHaveLength(0);
      expect(panel.skipped[0]?.reason).toContain("not in models");
    }
  });

  test("a MODEL reviewer naming an inherited name is skipped too", () => {
    // The same hole was on the model path and only the new one was reported.
    const panel = resolvePanel(
      cfg([{ kind: "model", id: "m", entry: "constructor" }]),
      { name: "builder", entry: local }
    );

    expect(panel.reviewers).toHaveLength(0);
    expect(panel.skipped[0]?.reason).toContain("not in models");
  });
});

describe("one model, one vote", () => {
  /**
   * Independence was only ever checked against the BUILDER. Two reviewers
   * fronting the same model both counted, so a single model cast two votes —
   * and the panel reported agreement of 2, which is the number the gate is read
   * through. A model agreeing with itself is not agreement.
   */
  test("a model reviewer and a binary fronting it do not both vote", () => {
    const panel = resolvePanel(
      cfg([
        { kind: "model", id: "api", entry: "elsewhere" },
        { ...binary, id: "cli", fronts: "elsewhere" },
      ]),
      { name: "builder", entry: local }
    );

    expect(panel.reviewers.map((r) => r.id)).toEqual(["api"]);
    expect(panel.skipped[0]?.reason).toContain("one model, one vote");
  });

  test("two model reviewers on the same host and model id collapse to one", () => {
    const panel = resolvePanel(
      {
        active: "builder",
        models: { builder: local, a: other, b: { ...other } },
        reviewPanel: {
          minReviewers: 2,
          reviewers: [
            { kind: "model", id: "first", entry: "a" },
            { kind: "model", id: "second", entry: "b" },
          ],
        },
      },
      { name: "builder", entry: local }
    );

    expect(panel.reviewers.map((r) => r.id)).toEqual(["first"]);
  });

  test("genuinely different models both vote", () => {
    const third: IModelEntry = {
      baseUrl: "https://openrouter.ai/api/v1",
      model: "z-ai/glm-5.2",
    };
    const panel = resolvePanel(
      {
        active: "builder",
        models: { builder: local, a: other, b: third },
        reviewPanel: {
          minReviewers: 2,
          reviewers: [
            { kind: "model", id: "first", entry: "a" },
            { kind: "model", id: "second", entry: "b" },
          ],
        },
      },
      { name: "builder", entry: local }
    );

    expect(panel.reviewers.map((r) => r.id)).toEqual(["first", "second"]);
  });

  test("two UNDECLARED binaries both vote — nothing says they are the same", () => {
    // The limit of what can be known. Guessing that two opaque commands are one
    // model would disable working panels on a hunch.
    const panel = resolvePanel(
      cfg([
        { ...binary, id: "cli-a" },
        { ...binary, id: "cli-b" },
      ]),
      { name: "builder", entry: local }
    );

    expect(panel.reviewers.map((r) => r.id)).toEqual(["cli-a", "cli-b"]);
  });
});

describe("__proto__ specifically", () => {
  test("it yields an object rather than a function, and is still refused", () => {
    // Called out in the helper's own doc and behaves unlike the others:
    // models["__proto__"] is Object.prototype, an OBJECT, so a truthiness check
    // would not have saved it either.
    const panel = resolvePanel(cfg([{ ...binary, fronts: "__proto__" }]), {
      name: "builder",
      entry: local,
    });

    expect(panel.reviewers).toHaveLength(0);
    expect(panel.skipped[0]?.reason).toContain("not in models");
  });
});
