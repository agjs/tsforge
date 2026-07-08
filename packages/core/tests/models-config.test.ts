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
  resolveModelByName,
  resolveCapabilityModel,
  modelsConfigPath,
  defaultModelsConfig,
} from "../src/models-config";

// Capability env overrides — cleared before each test and restored after, so the
// registry (not ambient env) is what's under test unless a test sets them.
const CAP_ENV = [
  "TSFORGE_VISION_BASE_URL",
  "TSFORGE_VISION_MODEL",
  "TSFORGE_VISION_API_KEY",
  "TSFORGE_IMAGE_BASE_URL",
  "TSFORGE_IMAGE_MODEL",
  "TSFORGE_IMAGE_API_KEY",
  "TSFORGE_IMAGE_API",
] as const;
const savedCap = new Map(CAP_ENV.map((k) => [k, process.env[k]] as const));

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

  for (const k of CAP_ENV) {
    Reflect.deleteProperty(process.env, k);
  }
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  restore("TSFORGE_HOME", saved.home);
  restore("TSFORGE_BASE_URL", saved.base);
  restore("TSFORGE_MODEL", saved.model);
  restore("TSFORGE_API_KEY", saved.key);

  for (const [k, v] of savedCap) {
    restore(k, v);
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}

test("resolveModelByName: known name, unknown name, and unset all resolve", async () => {
  await saveModelsConfig({
    active: "work",
    models: {
      work: { baseUrl: "http://w", model: "work-model" },
      judge: { baseUrl: "http://j", model: "judge-model" },
    },
  });

  // a known role name resolves to that entry
  expect((await resolveModelByName("judge")).entry.model).toBe("judge-model");
  // an unknown name falls back to the active model (never throws)
  expect((await resolveModelByName("nope")).entry.model).toBe("work-model");
  // unset / empty falls back to the active model too
  expect((await resolveModelByName(undefined)).entry.model).toBe("work-model");
  expect((await resolveModelByName("")).entry.model).toBe("work-model");
});

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

// P2 (review): a hand-edited `"maxTokens": "8192"` (string) passed validation and
// reached the request body as a string, which the provider rejects confusingly.
// Numeric fields must be type-checked with an actionable message.
test("parseModelsConfig requires maxTokens / contextWindow to be positive integers", () => {
  // Wrong type (string), non-integer (float), and non-positive all rejected.
  expect(() =>
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "u", model: "m", maxTokens: "8192" } },
    })
  ).toThrow(/maxTokens must be a positive integer/);

  expect(() =>
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "u", model: "m", maxTokens: 8192.5 } },
    })
  ).toThrow(/maxTokens must be a positive integer/);

  expect(() =>
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "u", model: "m", contextWindow: 0 } },
    })
  ).toThrow(/contextWindow must be a positive integer/);

  // A correct integer still parses.
  expect(
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "u", model: "m", maxTokens: 8192 } },
    }).models.a?.maxTokens
  ).toBe(8192);
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

test("capabilities: parse validates known keys + real entry targets, round-trips", async () => {
  await saveModelsConfig({
    active: "qwen-local",
    models: {
      "qwen-local": { baseUrl: "http://x/v1", model: "qwen3.6-27b" },
      "or-vlm": { baseUrl: "https://openrouter.ai/api/v1", model: "vlm" },
    },
    capabilities: { vision: "or-vlm" },
  });

  const cfg = await loadModelsConfig();

  expect(cfg.capabilities?.vision).toBe("or-vlm");

  // unknown capability key rejected
  expect(() =>
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "u", model: "m" } },
      capabilities: { audio: "a" },
    })
  ).toThrow(/unknown capability "audio"/);

  // dangling entry reference rejected
  expect(() =>
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "u", model: "m" } },
      capabilities: { vision: "ghost" },
    })
  ).toThrow(/capability "vision" must name a model/);
});

test("resolveCapabilityModel: null when unconfigured, else the registry entry", async () => {
  await saveModelsConfig({
    active: "qwen-local",
    models: {
      "qwen-local": { baseUrl: "http://x/v1", model: "qwen3.6-27b" },
      "or-vlm": { baseUrl: "https://openrouter.ai/api/v1", model: "vlm" },
    },
    capabilities: { vision: "or-vlm" },
  });

  const vision = await resolveCapabilityModel("vision");

  expect(vision?.name).toBe("or-vlm");
  expect(vision?.entry.model).toBe("vlm");
  // imageGen isn't configured → off
  expect(await resolveCapabilityModel("imageGen")).toBeNull();
});

test("resolveCapabilityModel: ad-hoc env entry wins and needs no models.json", async () => {
  process.env.TSFORGE_VISION_BASE_URL = "https://vlm.example/v1";
  process.env.TSFORGE_VISION_MODEL = "some-vlm";
  process.env.TSFORGE_VISION_API_KEY = "sk-test";

  const vision = await resolveCapabilityModel("vision");

  expect(vision?.name).toBe("env:vision");
  expect(vision?.entry.baseUrl).toBe("https://vlm.example/v1");
  expect(vision?.entry.model).toBe("some-vlm");
  expect(vision?.entry.apiKey).toBe("sk-test");

  // base url without a model is an actionable error, not a silent bad entry
  delete process.env.TSFORGE_VISION_MODEL;
  await expect(resolveCapabilityModel("vision")).rejects.toThrow(
    /TSFORGE_VISION_MODEL is missing/
  );
});

test("resolveCapabilityModel: env names a registry entry; imageApi override parses", async () => {
  await saveModelsConfig({
    active: "qwen-local",
    models: {
      "qwen-local": { baseUrl: "http://x/v1", model: "qwen3.6-27b" },
      "or-img": {
        baseUrl: "https://openrouter.ai/api/v1",
        model: "flux",
        imageApi: "chat-modalities",
      },
    },
  });

  // env names an entry (no base url set) → reuse that registry entry
  process.env.TSFORGE_IMAGE_MODEL = "or-img";
  const img = await resolveCapabilityModel("imageGen");

  expect(img?.name).toBe("or-img");
  expect(img?.entry.imageApi).toBe("chat-modalities");

  // ad-hoc env with an imageApi override
  delete process.env.TSFORGE_IMAGE_MODEL;
  process.env.TSFORGE_IMAGE_BASE_URL = "https://img.example/v1";
  process.env.TSFORGE_IMAGE_MODEL = "dalle";
  process.env.TSFORGE_IMAGE_API = "images-generations";

  const adhoc = await resolveCapabilityModel("imageGen");

  expect(adhoc?.entry.imageApi).toBe("images-generations");
});
