import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePanel } from "../src/reviewers/registry";
import {
  parseModelsConfig,
  modelByName,
  saveModelsConfig,
} from "../src/models-config";
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

describe("the prototype hardening at its real call sites", () => {
  /**
   * Six plain index reads became own-property lookups, and none of the call
   * sites was covered — the resolvePanel tests reach only one of them. These are
   * the ones where a plain read is worse than a skip: validation PASSES and
   * something that is not a model is handed on.
   */
  const registry = (over: Record<string, unknown>): unknown => ({
    active: "builder",
    models: { builder: { baseUrl: "http://x/v1", model: "m" } },
    ...over,
  });

  test("an inherited name as `active` is rejected, not resolved to a function", () => {
    for (const name of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(() => parseModelsConfig(registry({ active: name }))).toThrow(
        /active/
      );
    }
  });

  test("an inherited name as a capability target is rejected", () => {
    expect(() =>
      parseModelsConfig(registry({ capabilities: { vision: "constructor" } }))
    ).toThrow();
  });

  test("a model reviewer naming an inherited entry is rejected at parse", () => {
    expect(() =>
      parseModelsConfig(
        registry({
          reviewPanel: {
            minReviewers: 2,
            reviewers: [{ kind: "model", id: "r", entry: "constructor" }],
          },
        })
      )
    ).toThrow();
  });

  test("a model named __proto__ is REFUSED, not quietly stored", () => {
    // Policy changed from storing it to rejecting it. A null-prototype registry
    // could hold it safely, but saveModelsConfig serialises with JSON.stringify
    // and would write a literal "__proto__" key back into models.json — a file
    // other tools parse, where a plain JSON.parse and spread poisons whatever
    // reads it. Refusing the name costs a user nothing.
    //
    // Built as TEXT: `{ __proto__: ... }` in a JS object literal sets the
    // prototype before JSON.stringify sees it, so the key would be gone before
    // the code under test ran. Only JSON.parse makes it a real property.
    expect(() =>
      parseModelsConfig(
        JSON.parse(
          '{"active":"builder","models":{"builder":{"baseUrl":"http://x/v1","model":"m"},' +
            '"__proto__":{"baseUrl":"http://y/v1","model":"n"}}}'
        )
      )
    ).toThrow(/__proto__/);
  });

  test("an inherited name is never a configured model, whatever the shape", () => {
    // The registry is a plain object, so `models.constructor` IS an inherited
    // function — the guarantee is that no lookup treats it as a model, not that
    // the property is absent.
    const cfg = parseModelsConfig({
      active: "builder",
      models: { builder: { baseUrl: "http://x/v1", model: "m" } },
    });

    for (const name of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(modelByName(cfg.models, name)).toBeUndefined();
    }

    expect(modelByName(cfg.models, "builder")?.model).toBe("m");
  });
});

describe("fronts is validated against the registry at parse time", () => {
  test("a well-formed typo is rejected, not discovered mid-run", () => {
    // The model path throws when `entry` names nothing; this one only checked
    // the TYPE, so "buidler" parsed fine and surfaced later as a reviewer
    // quietly skipped in the middle of a review.
    expect(() =>
      parseModelsConfig({
        active: "builder",
        models: { builder: { baseUrl: "http://x/v1", model: "m" } },
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
              fronts: "buidler",
            },
          ],
        },
      })
    ).toThrow(/not a configured model/);
  });
});

describe("caller-supplied config, which the parser never saw", () => {
  /**
   * Where `modelByName` earns its place — which is everywhere, not only here.
   *
   * An earlier draft of this comment said the parser produces a null-prototype
   * registry so the runtime sites were safe by construction. That was true of a
   * design I backed out of: `parseModelsConfig` builds a plain `{}` (see its
   * comment for why), so every lookup inherits Object.prototype and every one of
   * them needs the guard.
   *
   * `resolvePanel` is the case exercised below because it is exported and takes
   * a config the caller built — the shape the harness itself passes from tests
   * and tools, which the parser never sees.
   */
  test("an inherited name in a hand-built registry resolves to nothing", () => {
    const panel = resolvePanel(
      {
        active: "builder",
        models: { builder: local },
        reviewPanel: {
          minReviewers: 2,
          reviewers: [{ kind: "model", id: "r", entry: "toString" }],
        },
      },
      { name: "builder", entry: local }
    );

    expect(panel.reviewers).toHaveLength(0);
    expect(panel.skipped[0]?.reason).toContain("not in models");
  });
});

describe("a fronts declaration on the wrong reviewer kind", () => {
  test("a MODEL reviewer carrying `fronts` is rejected", () => {
    // Only the binary path reads it, so a model reviewer with one looks
    // annotated and is not — the silent declaration this field exists to stop.
    expect(() =>
      parseModelsConfig({
        active: "builder",
        models: { builder: { baseUrl: "http://x/v1", model: "m" } },
        reviewPanel: {
          minReviewers: 2,
          reviewers: [
            { kind: "model", id: "r", entry: "builder", fronts: "builder" },
          ],
        },
      })
    ).toThrow(/fronts/);
  });
});

describe("identity is by HOSTNAME, deliberately coarse", () => {
  test("two ports on one host count as one model", () => {
    // Including the port reads as more precise and is a RELAXATION: it makes
    // identity finer, so two endpoints on one machine serving the same model id
    // both get to vote. The likeliest thing that looks like that is one model
    // served twice on one box — the self-review this exists to prevent. Coarser
    // errs toward refusing a genuine second reviewer; finer errs toward letting
    // one model vote twice, and only the second failure is silent.
    const a: IModelEntry = { baseUrl: "http://spark:8888/v1", model: "m" };
    const b: IModelEntry = { baseUrl: "http://spark:9999/v1", model: "m" };
    const panel = resolvePanel(
      {
        active: "builder",
        models: { builder: local, a, b },
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
    expect(panel.skipped[0]?.reason).toContain("one model, one vote");
  });
});

describe("a declaration on the wrong reviewer kind — both directions", () => {
  const registry = (reviewer: unknown): unknown => ({
    active: "builder",
    models: { builder: { baseUrl: "http://x/v1", model: "m" } },
    reviewPanel: { minReviewers: 2, reviewers: [reviewer] },
  });

  test("a BINARY reviewer carrying `entry` is refused", () => {
    // The mirror I added a commit ago and did not test, while claiming both
    // directions were covered. Only the model path reads `entry`, so a binary
    // with one looks like it named its model and did not.
    expect(() =>
      parseModelsConfig(
        registry({
          kind: "binary",
          id: "cli",
          argv: ["cli"],
          input: "arg",
          timeoutMs: 1000,
          parse: "raw",
          entry: "builder",
        })
      )
    ).toThrow(/entry/);
  });

  test("a MODEL reviewer carrying `fronts` is refused", () => {
    expect(() =>
      parseModelsConfig(
        registry({
          kind: "model",
          id: "r",
          entry: "builder",
          fronts: "builder",
        })
      )
    ).toThrow(/fronts/);
  });
});

describe("saving cannot emit a poisoned key either", () => {
  /**
   * SANDBOXED. `saveModelsConfig` writes to `$TSFORGE_HOME/.tsforge` and falls
   * back to the real home when that is unset — so an earlier version of this
   * test overwrote the developer's own models.json during a mutation run, when
   * the guard was removed and the write went through. A test that reaches the
   * machine it runs on is a bug regardless of what it asserts.
   */
  let home: string;
  const savedHome = process.env.TSFORGE_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "tsforge-save-guard-"));
    process.env.TSFORGE_HOME = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) {
      delete process.env.TSFORGE_HOME;
    } else {
      process.env.TSFORGE_HOME = savedHome;
    }

    await rm(home, { recursive: true, force: true });
  });

  test("a hand-built config with a __proto__ model is refused at save", async () => {
    // The refusal exists so the name never reaches models.json, which other
    // tools parse — so it has to sit on the WRITE path too, not only the parse
    // path, because saveModelsConfig is exported and takes a config the parser
    // never saw.
    const models: Record<string, IModelEntry> = { builder: local };

    Object.defineProperty(models, "__proto__", {
      value: local,
      enumerable: true,
      configurable: true,
    });

    // AWAITED. `expect(promise).rejects` in a non-async callback returns a
    // promise nobody waits on, so the assertion can never run and the test
    // passes having checked nothing — a guarantee asserted and not verified,
    // which is the failure this whole PR is about.
    await expect(
      saveModelsConfig({ active: "builder", models })
    ).rejects.toThrow(/__proto__/);
  });
});
