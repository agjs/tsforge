import { test, expect, beforeEach, afterEach } from "bun:test";
import { providerConfig } from "../src/cli/model-setup";
import { buildRequestBody } from "../src/inference/request";
import type { ReasoningStyle } from "../src/inference/reasoning-profile";
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
  CAPABILITY_NAMES,
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

test("missing registry → the built-in local default (no file written)", async () => {
  const cfg = await loadModelsConfig();

  expect(cfg.active).toBe("local");
  expect(cfg.models.local?.model).toBe(
    defaultModelsConfig().models.local?.model
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
      models: { a: { baseUrl: "http://localhost:1234/v1", model: "m" } },
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
      models: {
        a: {
          baseUrl: "http://localhost:1234/v1",
          model: "m",
          maxTokens: "8192",
        },
      },
    })
  ).toThrow(/maxTokens must be a positive integer/);

  expect(() =>
    parseModelsConfig({
      active: "a",
      models: {
        a: {
          baseUrl: "http://localhost:1234/v1",
          model: "m",
          maxTokens: 8192.5,
        },
      },
    })
  ).toThrow(/maxTokens must be a positive integer/);

  expect(() =>
    parseModelsConfig({
      active: "a",
      models: {
        a: {
          baseUrl: "http://localhost:1234/v1",
          model: "m",
          contextWindow: 0,
        },
      },
    })
  ).toThrow(/contextWindow must be a positive integer/);

  // A correct integer still parses.
  expect(
    parseModelsConfig({
      active: "a",
      models: {
        a: { baseUrl: "http://localhost:1234/v1", model: "m", maxTokens: 8192 },
      },
    }).models.a?.maxTokens
  ).toBe(8192);
});

test("parseModelsConfig requires apiKey/apiKeyEnv to be strings (else the key silently vanishes)", () => {
  expect(() =>
    parseModelsConfig({
      active: "a",
      models: {
        a: { baseUrl: "http://localhost:1234/v1", model: "m", apiKey: 12345 },
      },
    })
  ).toThrow(/apiKey must be a string/);

  expect(() =>
    parseModelsConfig({
      active: "a",
      models: {
        a: { baseUrl: "http://localhost:1234/v1", model: "m", apiKeyEnv: true },
      },
    })
  ).toThrow(/apiKeyEnv must be a string/);
});

test("parseModelsConfig rejects a malformed baseUrl at the JSON boundary (not mid-turn)", () => {
  expect(() =>
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "api.host/v1", model: "m" } }, // no scheme
    })
  ).toThrow(/baseUrl is not a valid URL/);
});

test("parseModelsConfig rejects minReviewers <= 0 (a 0 would satisfy review with zero votes)", () => {
  expect(() =>
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "http://localhost:1234/v1", model: "m" } },
      reviewPanel: { minReviewers: 0, reviewers: [] },
    })
  ).toThrow(/minReviewers must be a positive integer/);

  // A valid positive integer still parses.
  expect(
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "http://localhost:1234/v1", model: "m" } },
      reviewPanel: { minReviewers: 3, reviewers: [] },
    }).reviewPanel?.minReviewers
  ).toBe(3);
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

test("setActiveModel preserves the capabilities block (does not drop it)", async () => {
  await saveModelsConfig({
    active: "qwen-local",
    models: {
      "qwen-local": { baseUrl: "http://x/v1", model: "qwen3.6-27b" },
      deepseek: {
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-reasoner",
      },
      "or-vlm": { baseUrl: "https://openrouter.ai/api/v1", model: "vlm" },
    },
    capabilities: { vision: "or-vlm" },
  });

  const next = await setActiveModel("deepseek");

  expect(next.active).toBe("deepseek");
  // capabilities must survive a model switch (P1: was silently dropped)
  expect(next.capabilities?.vision).toBe("or-vlm");
  expect((await loadModelsConfig()).capabilities?.vision).toBe("or-vlm");
});

test("resolveApiKey: inline wins, else apiKeyEnv, else undefined", () => {
  expect(
    resolveApiKey({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      apiKey: "inline",
    })
  ).toBe("inline");

  process.env.DEEPSEEK_API_KEY = "from-env";
  expect(
    resolveApiKey({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    })
  ).toBe("from-env");
  delete process.env.DEEPSEEK_API_KEY;

  expect(
    resolveApiKey({ baseUrl: "http://localhost:1234/v1", model: "m" })
  ).toBeUndefined();
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
      models: { a: { baseUrl: "http://localhost:1234/v1", model: "m" } },
      capabilities: { audio: "a" },
    })
  ).toThrow(/unknown capability "audio"/);

  // dangling entry reference rejected
  expect(() =>
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "http://localhost:1234/v1", model: "m" } },
      capabilities: { vision: "ghost" },
    })
  ).toThrow(/capability "vision" must name a model/);
});

test("capabilities: every CAPABILITY_NAMES key (incl. planner + expert) is a valid config target", () => {
  // Regression: parseCapabilities hardcoded {vision,imageGen,expert} and rejected
  // `planner`, even though planner IS a CapabilityName routable via env — so a
  // planner role could never be set in models.json. The allowlist now derives from
  // CAPABILITY_NAMES, so config and env agree on the full capability set.
  const cfg = parseModelsConfig({
    active: "a",
    models: { a: { baseUrl: "http://localhost:1234/v1", model: "m" } },
    capabilities: {
      vision: "a",
      imageGen: "a",
      expert: "a",
      planner: "a",
    },
  });

  expect(cfg.capabilities?.vision).toBe("a");
  expect(cfg.capabilities?.imageGen).toBe("a");
  expect(cfg.capabilities?.expert).toBe("a");
  expect(cfg.capabilities?.planner).toBe("a");
});

test("parseModelsConfig rejects a bad imageApi (fails loud, no silent fallback)", () => {
  expect(() =>
    parseModelsConfig({
      active: "a",
      models: {
        a: {
          baseUrl: "http://localhost:1234/v1",
          model: "m",
          imageApi: "chat-modality",
        },
      },
    })
  ).toThrow(/imageApi must be/);

  // valid values still parse
  expect(
    parseModelsConfig({
      active: "a",
      models: {
        a: {
          baseUrl: "http://localhost:1234/v1",
          model: "m",
          imageApi: "images-generations",
        },
      },
    }).models.a?.imageApi
  ).toBe("images-generations");
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

test("planner is a routable capability role", () => {
  expect(CAPABILITY_NAMES).toContain("planner");
});

test("parseModelsConfig accepts a preset NAME or a well-formed reasoning profile", () => {
  const entry = (reasoning: unknown) => ({
    active: "a",
    models: {
      a: { baseUrl: "http://localhost:1234/v1", model: "m", reasoning },
    },
  });

  const presets: ReasoningStyle[] = [
    "qwen",
    "deepseek",
    "deepseek-local",
    "openai",
    "none",
  ];

  for (const name of presets) {
    expect(parseModelsConfig(entry(name)).models.a?.reasoning).toBe(name);
  }

  const profile = {
    thinking: { path: "chat_template_kwargs.thinking" },
    effort: "chat_template_kwargs.reasoning_effort",
    budget: "thinking_token_budget",
    latchThinking: false,
  };

  expect(parseModelsConfig(entry(profile)).models.a?.reasoning).toEqual(
    profile
  );

  // absent stays absent (auto-detection applies at request time)
  expect(
    parseModelsConfig({
      active: "a",
      models: { a: { baseUrl: "http://localhost:1234/v1", model: "m" } },
    }).models.a?.reasoning
  ).toBeUndefined();
});

test("parseModelsConfig rejects a bad reasoning value at the JSON boundary", () => {
  const bad = (reasoning: unknown) => () =>
    parseModelsConfig({
      active: "a",
      models: {
        a: { baseUrl: "http://localhost:1234/v1", model: "m", reasoning },
      },
    });

  // A typo would otherwise behave as an empty profile: load fine, then silently
  // send no reasoning fields at all.
  expect(bad("qwne")).toThrow(/reasoning must be/);
  // null is not undefined — it used to reach the request builder and throw.
  expect(bad(null)).toThrow(/reasoning must be/);
  expect(bad(42)).toThrow(/reasoning must be/);
  expect(bad([])).toThrow(/reasoning must be/);
  // misspelled profile keys must not validate
  expect(bad({ budegt: "x" })).toThrow(/reasoning must be/);
  // structurally wrong members
  expect(bad({ thinking: true })).toThrow(/reasoning must be/);
  expect(bad({ thinking: {} })).toThrow(/reasoning must be/);
  expect(bad({ effort: 5 })).toThrow(/reasoning must be/);
  expect(bad({ latchThinking: "yes" })).toThrow(/reasoning must be/);
  // a path that would escape into the prototype chain
  expect(bad({ thinking: { path: "__proto__.x" } })).toThrow(
    /reasoning must be/
  );
  expect(bad({ budget: "a..b" })).toThrow(/reasoning must be/);
});

test("a reasoning profile survives save → load → providerConfig → request body", async () => {
  // The CLI wizard and /model write entries through this same path, so a
  // profile must round-trip end to end, not just validate at parse time.
  const profile = {
    thinking: { path: "chat_template_kwargs.thinking" },
    effort: "chat_template_kwargs.reasoning_effort",
    budget: "thinking_token_budget",
  };

  await saveModelsConfig({
    active: "local",
    models: {
      local: {
        baseUrl: "http://192.168.1.10:8000/v1",
        model: "deepseek-v4-flash",
        reasoning: profile,
        reasoningEffort: "low",
      },
    },
  });

  const loaded = await loadModelsConfig();
  const entry = loaded.models.local;

  if (entry === undefined) {
    throw new Error("expected the saved entry to load back");
  }

  expect(entry.reasoning).toEqual(profile);

  const cfg = providerConfig(entry);

  expect(cfg.reasoning).toEqual(profile);

  const bodyOut = buildRequestBody(
    cfg,
    [{ role: "user", content: "hi" }],
    { enableThinking: false },
    false
  );

  expect(bodyOut.chat_template_kwargs).toEqual({
    thinking: false,
    reasoning_effort: "low",
  });
});

test("a preset NAME still round-trips through the wizard's providerConfig", async () => {
  await saveModelsConfig({
    active: "cloud",
    models: {
      cloud: {
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-v4-pro",
        reasoning: "deepseek",
        reasoningEffort: "high",
      },
    },
  });

  const loaded = await loadModelsConfig();
  const entry = loaded.models.cloud;

  if (entry === undefined) {
    throw new Error("expected the saved entry to load back");
  }

  const cfg = providerConfig(entry);

  expect(cfg.reasoning).toBe("deepseek");

  const bodyOut = buildRequestBody(
    cfg,
    [{ role: "user", content: "hi" }],
    { enableThinking: true },
    false
  );

  expect(bodyOut.thinking).toEqual({ type: "enabled" });
  expect(bodyOut.reasoning_effort).toBe("high");
});
