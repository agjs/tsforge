import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModelsConfig,
  saveModelsConfig,
  setActiveModel,
  parseModelsConfig,
  resolveApiKey,
  envModelEntry,
  resolveActiveModel,
  modelsConfigPath,
  defaultModelsConfig,
} from "../src/models-config";

// Sandbox the registry under a temp $TSFORGE_HOME, and clear the TSFORGE_* env
// overrides so the registry (not the ambient env) is what's under test.
const saved = {
  home: process.env.TSFORGE_HOME,
  base: process.env.TSFORGE_BASE_URL,
  model: process.env.TSFORGE_MODEL,
  key: process.env.TSFORGE_API_KEY,
};
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "tsforge-models-"));
  process.env.TSFORGE_HOME = home;
  delete process.env.TSFORGE_BASE_URL;
  delete process.env.TSFORGE_MODEL;
  delete process.env.TSFORGE_API_KEY;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  restore("TSFORGE_HOME", saved.home);
  restore("TSFORGE_BASE_URL", saved.base);
  restore("TSFORGE_MODEL", saved.model);
  restore("TSFORGE_API_KEY", saved.key);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}

test("missing registry → the built-in local-qwen default (no file written)", async () => {
  const cfg = await loadModelsConfig();

  expect(cfg.active).toBe("qwen-local");
  expect(cfg.models["qwen-local"]?.model).toBe(
    defaultModelsConfig().models["qwen-local"]?.model
  );
  // load is read-only: it must NOT create the file as a side effect.
  expect(await Bun.file(modelsConfigPath()).exists()).toBe(false);
});

test("save then load round-trips N models", async () => {
  await saveModelsConfig({
    active: "deepseek",
    models: {
      "qwen-local": { baseUrl: "http://x/v1", model: "qwen3.6-27b" },
      deepseek: {
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-reasoner",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        contextWindow: 65536,
      },
    },
  });

  const cfg = await loadModelsConfig();

  expect(Object.keys(cfg.models).sort()).toEqual(["deepseek", "qwen-local"]);
  expect(cfg.active).toBe("deepseek");
  expect(cfg.models.deepseek?.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
});

test("parseModelsConfig rejects bad shapes with actionable errors", () => {
  expect(() => parseModelsConfig({ models: {} })).toThrow(/active/);
  expect(() =>
    parseModelsConfig({ active: "a", models: { a: { model: "m" } } })
  ).toThrow(/baseUrl/);
  expect(() =>
    parseModelsConfig({
      active: "ghost",
      models: { a: { baseUrl: "u", model: "m" } },
    })
  ).toThrow(/not one of/);
});

test("setActiveModel switches + persists; unknown name throws with the options", async () => {
  await saveModelsConfig({
    active: "qwen-local",
    models: {
      "qwen-local": { baseUrl: "http://x/v1", model: "qwen3.6-27b" },
      deepseek: {
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-reasoner",
      },
    },
  });

  const next = await setActiveModel("deepseek");

  expect(next.active).toBe("deepseek");
  // persisted to disk
  const onDisk: unknown = JSON.parse(
    await readFile(modelsConfigPath(), "utf8")
  );

  expect(parseModelsConfig(onDisk).active).toBe("deepseek");

  await expect(setActiveModel("gpt5")).rejects.toThrow(
    /unknown model "gpt5".*deepseek/s
  );
});

test("resolveApiKey: inline wins, else apiKeyEnv, else undefined", () => {
  expect(resolveApiKey({ baseUrl: "u", model: "m", apiKey: "inline" })).toBe(
    "inline"
  );

  process.env.DEEPSEEK_API_KEY = "from-env";
  expect(
    resolveApiKey({ baseUrl: "u", model: "m", apiKeyEnv: "DEEPSEEK_API_KEY" })
  ).toBe("from-env");
  delete process.env.DEEPSEEK_API_KEY;

  expect(resolveApiKey({ baseUrl: "u", model: "m" })).toBeUndefined();
});

test("explicit TSFORGE_* env overrides the registry's active model", async () => {
  await saveModelsConfig({
    active: "qwen-local",
    models: { "qwen-local": { baseUrl: "http://x/v1", model: "qwen3.6-27b" } },
  });

  expect(envModelEntry()).toBeUndefined();
  expect((await resolveActiveModel()).name).toBe("qwen-local");

  process.env.TSFORGE_BASE_URL = "https://api.deepseek.com/v1";
  process.env.TSFORGE_MODEL = "deepseek-reasoner";

  const active = await resolveActiveModel();

  expect(active.name).toBe("env");
  expect(active.entry.model).toBe("deepseek-reasoner");
  expect(active.entry.baseUrl).toBe("https://api.deepseek.com/v1");
});
