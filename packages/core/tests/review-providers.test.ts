import { test, expect, afterEach } from "bun:test";
import { parseModelsConfig } from "../src/models-config";
import { resolveReviewProviders } from "../src/cli/model-setup";

const RAW = {
  active: "main",
  models: {
    main: { baseUrl: "http://localhost:8000/v1", model: "main-model" },
    rev1: { baseUrl: "http://localhost:8001/v1", model: "rev1-model" },
    rev2: { baseUrl: "http://localhost:8002/v1", model: "rev2-model" },
  },
};

afterEach(() => {
  delete process.env.TSFORGE_REVIEW_MODEL;
  delete process.env.TSFORGE_REVIEW_BASE_URL;
  delete process.env.TSFORGE_REVIEW_API_KEY;
});

test("parseModelsConfig accepts reviewModels naming real entries", () => {
  const cfg = parseModelsConfig({ ...RAW, reviewModels: ["rev1", "rev2"] });

  expect(cfg.reviewModels).toEqual(["rev1", "rev2"]);
});

test("parseModelsConfig rejects a reviewModels name that isn't a model", () => {
  expect(() => parseModelsConfig({ ...RAW, reviewModels: ["nope"] })).toThrow(
    /reviewModels/
  );
});

test("parseModelsConfig rejects a non-array reviewModels", () => {
  expect(() => parseModelsConfig({ ...RAW, reviewModels: "rev1" })).toThrow(
    /reviewModels/
  );
});

test("no reviewModels and no env ⇒ empty (caller falls back to the main model)", () => {
  const cfg = parseModelsConfig(RAW);

  expect(resolveReviewProviders(cfg)).toHaveLength(0);
});

test("one reviewModel ⇒ one reviewer provider", () => {
  const cfg = parseModelsConfig({ ...RAW, reviewModels: ["rev1"] });

  expect(resolveReviewProviders(cfg)).toHaveLength(1);
});

test("several reviewModels ⇒ a panel of that many providers", () => {
  const cfg = parseModelsConfig({ ...RAW, reviewModels: ["rev1", "rev2"] });

  expect(resolveReviewProviders(cfg)).toHaveLength(2);
});

test("TSFORGE_REVIEW_* env is a single ad-hoc reviewer that wins over reviewModels", () => {
  const cfg = parseModelsConfig({ ...RAW, reviewModels: ["rev1", "rev2"] });

  process.env.TSFORGE_REVIEW_BASE_URL = "http://localhost:9000/v1";
  process.env.TSFORGE_REVIEW_MODEL = "env-reviewer";

  // env override collapses the panel to the one ad-hoc reviewer
  expect(resolveReviewProviders(cfg)).toHaveLength(1);
});

test("TSFORGE_REVIEW_MODEL alone names a registry entry", () => {
  const cfg = parseModelsConfig(RAW);

  process.env.TSFORGE_REVIEW_MODEL = "rev2";

  expect(resolveReviewProviders(cfg)).toHaveLength(1);
});
