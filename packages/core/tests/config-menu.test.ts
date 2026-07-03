import { test, expect } from "bun:test";
import {
  addModel,
  buildAddModelSteps,
  buildConfigMenu,
  buildModelPickStep,
  draftToEntry,
} from "../src/cli/config-menu";
import type { IModelsConfig } from "../src/models-config";

const CFG: IModelsConfig = {
  active: "b",
  models: {
    a: { baseUrl: "http://a/v1", model: "m-a" },
    b: { baseUrl: "http://b/v1", model: "m-b" },
  },
};

test("buildConfigMenu offers switch + add, and names the current model", () => {
  const menu = buildConfigMenu("qwen-local");

  expect(menu.kind).toBe("single");
  expect(menu.options.map((o) => o.value)).toEqual([
    "switch-model",
    "add-model",
  ]);
  expect(menu.options[0]?.outcome).toContain("qwen-local");
});

test("buildModelPickStep lists all models and defaults to the active one", () => {
  const step = buildModelPickStep(CFG);

  expect(step.options.map((o) => o.value)).toEqual(["a", "b"]);
  expect(step.defaultIndex).toBe(1); // "b" is active
});

test("buildAddModelSteps: four text fields; name/baseUrl/model required, apiKey masked+optional", () => {
  const steps = buildAddModelSteps();

  expect(steps.map((s) => s.key)).toEqual([
    "name",
    "baseUrl",
    "model",
    "apiKey",
  ]);
  expect(steps.every((s) => s.kind === "text")).toBe(true);

  const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));

  expect(byKey.name?.validate?.("")).toBe("Name is required");
  expect(byKey.name?.validate?.("x")).toBeNull();
  expect(byKey.baseUrl?.default).toBe("http://localhost:8000/v1");
  expect(byKey.apiKey?.mask).toBe(true);
  expect(byKey.apiKey?.validate).toBeUndefined(); // optional
});

test("draftToEntry trims fields and omits an empty apiKey", () => {
  const open = draftToEntry({
    name: "  local ",
    baseUrl: " http://x/v1 ",
    model: " m ",
    apiKey: "   ",
  });

  expect(open).toEqual({
    name: "local",
    entry: { baseUrl: "http://x/v1", model: "m" },
  });

  const keyed = draftToEntry({
    name: "cloud",
    baseUrl: "http://y/v1",
    model: "m2",
    apiKey: " sk-123 ",
  });

  expect(keyed.entry.apiKey).toBe("sk-123");
});

test("addModel adds the entry and makes it active (pure)", () => {
  const next = addModel(CFG, "c", { baseUrl: "http://c/v1", model: "m-c" });

  expect(next.active).toBe("c");
  expect(Object.keys(next.models)).toEqual(["a", "b", "c"]);
  // original config is untouched
  expect(CFG.active).toBe("b");
  expect(Object.keys(CFG.models)).toEqual(["a", "b"]);
});
