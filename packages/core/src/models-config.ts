import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { isRecord } from "./lib/guards";
import { PROVIDER_DEFAULTS } from "./inference/inference.constants";
import type { ReasoningStyle } from "./inference/inference.types";

/**
 * The model registry — `~/.tsforge/models.json`, the central place a user
 * configures N model endpoints and switches between them with `/model`. Mirrors
 * the sessions/logs layout (under `$TSFORGE_HOME` if set, else the home dir).
 * Loading is read-only and falls back to the built-in local-qwen default when no
 * file exists, so behaviour is identical to the env-driven path until the user
 * writes a registry.
 */
export interface IModelEntry {
  /** Root of the OpenAI-compatible API, e.g. https://api.deepseek.com/v1 */
  baseUrl: string;
  /** Model id sent in the request, e.g. deepseek-reasoner */
  model: string;
  /** Inline API key. Prefer `apiKeyEnv` so the secret stays out of the file. */
  apiKey?: string;
  /** Name of an env var holding the key — resolved at use time. Used when
   *  `apiKey` is unset, so the registry can be shared/committed without secrets. */
  apiKeyEnv?: string;
  /** Context window (tokens) for the status line + auto-compaction. */
  contextWindow?: number;
  /** Default thinking mode for this model. */
  thinking?: boolean;
  /** Per-response token cap override. */
  maxTokens?: number;
  /** Provider reasoning dialect: how thinking/reasoning is expressed on the wire.
   *  `qwen` (default) | `deepseek` | `openai` | `none`. Set `deepseek` for the
   *  DeepSeek API, `openai` for OpenAI o-series. */
  reasoning?: ReasoningStyle;
  /** Reasoning effort for `deepseek`/`openai` styles. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Arbitrary fields merged into the request body (override built-ins) — the
   *  escape hatch for any provider-specific param. */
  extraBody?: Record<string, unknown>;
  /** Arbitrary request headers (e.g. a non-Bearer auth scheme); `${VAR}` values
   *  are interpolated from the environment. */
  extraHeaders?: Record<string, string>;
}

export interface IModelsConfig {
  /** Name of the active entry — always a key of `models`. */
  active: string;
  models: Record<string, IModelEntry>;
}

/** The built-in local-qwen entry — matches PROVIDER_DEFAULTS so an absent
 *  registry behaves exactly like the current env-default path. */
const QWEN_LOCAL: IModelEntry = {
  baseUrl: PROVIDER_DEFAULTS.baseUrl,
  model: PROVIDER_DEFAULTS.model,
  thinking: true,
};

/** The default registry used when no models.json exists yet. */
export function defaultModelsConfig(): IModelsConfig {
  return { active: "qwen-local", models: { "qwen-local": QWEN_LOCAL } };
}

/** The registry path: `$TSFORGE_HOME`/.tsforge/models.json, else under home. */
export function modelsConfigPath(): string {
  return join(process.env.TSFORGE_HOME ?? homedir(), ".tsforge", "models.json");
}

function isModelEntry(value: unknown): value is IModelEntry {
  return (
    isRecord(value) &&
    typeof value.baseUrl === "string" &&
    typeof value.model === "string"
  );
}

/** A hand-edited `"maxTokens": "8192"` (string) passes `isModelEntry` (which only
 *  checks baseUrl/model) and the `??` fallback treats it as truthy, so the wrong
 *  type reaches the request body and the provider rejects it confusingly. Catch it
 *  here with an actionable message, matching this file's "fail loud, not silent"
 *  contract. Runs on the raw record so the typeof check is real (post-narrow it
 *  would be dead). JSON can't yield NaN, so a plain type check is enough. */
function assertNumericFields(name: string, entry: unknown): void {
  if (!isRecord(entry)) {
    return; // isModelEntry rejects non-records with its own message
  }

  for (const field of ["maxTokens", "contextWindow"]) {
    const value = entry[field];

    if (value !== undefined && typeof value !== "number") {
      throw new Error(
        `models.json: model "${name}" field ${field} must be a number, got ${typeof value}`
      );
    }
  }
}

/** Validate a parsed object into a registry, with actionable errors — the file is
 *  hand-edited, so a clear message beats a silent fallback. */
export function parseModelsConfig(raw: unknown): IModelsConfig {
  if (
    !isRecord(raw) ||
    typeof raw.active !== "string" ||
    !isRecord(raw.models)
  ) {
    throw new Error(
      "models.json: expected { active: string, models: { <name>: { baseUrl, model } } }"
    );
  }

  const models: Record<string, IModelEntry> = {};

  for (const [name, entry] of Object.entries(raw.models)) {
    if (!isModelEntry(entry)) {
      throw new Error(
        `models.json: model "${name}" needs at least { baseUrl, model }`
      );
    }

    assertNumericFields(name, entry);
    models[name] = entry;
  }

  if (models[raw.active] === undefined) {
    throw new Error(
      `models.json: active "${raw.active}" is not one of: ${Object.keys(models).join(", ")}`
    );
  }

  return { active: raw.active, models };
}

/** Read the registry (read-only). Missing file → the built-in default (no write);
 *  malformed file/JSON → a clear error naming the path. */
export async function loadModelsConfig(): Promise<IModelsConfig> {
  let text: string;

  try {
    text = await readFile(modelsConfigPath(), "utf8");
  } catch {
    return defaultModelsConfig();
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`models.json: invalid JSON at ${modelsConfigPath()}`);
  }

  return parseModelsConfig(raw);
}

/** Write the registry: dir 0700, file 0600 (it may hold an inline key). */
export async function saveModelsConfig(cfg: IModelsConfig): Promise<void> {
  const dir = join(process.env.TSFORGE_HOME ?? homedir(), ".tsforge");

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = modelsConfigPath();

  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Switch the active model and persist. Throws (listing the options) on an
 *  unknown name so `/model <typo>` gets a helpful message, not a silent no-op. */
export async function setActiveModel(name: string): Promise<IModelsConfig> {
  const cfg = await loadModelsConfig();

  if (cfg.models[name] === undefined) {
    throw new Error(
      `unknown model "${name}" — configured: ${Object.keys(cfg.models).join(", ")}`
    );
  }

  const next: IModelsConfig = { active: name, models: cfg.models };

  await saveModelsConfig(next);

  return next;
}

/** The API key for an entry: inline `apiKey` wins, else the env var named by
 *  `apiKeyEnv`. Undefined when neither is set (local endpoints need none). */
export function resolveApiKey(entry: IModelEntry): string | undefined {
  if (entry.apiKey !== undefined && entry.apiKey.length > 0) {
    return entry.apiKey;
  }

  if (entry.apiKeyEnv !== undefined) {
    return process.env[entry.apiKeyEnv];
  }

  return undefined;
}

/** An ad-hoc entry built from TSFORGE_* env, or undefined when none are set.
 *  Explicit env is the escape hatch that overrides the registry on startup. */
export function envModelEntry(): IModelEntry | undefined {
  const baseUrl = process.env.TSFORGE_BASE_URL;
  const model = process.env.TSFORGE_MODEL;

  if (baseUrl === undefined && model === undefined) {
    return undefined;
  }

  return {
    baseUrl: baseUrl ?? PROVIDER_DEFAULTS.baseUrl,
    model: model ?? PROVIDER_DEFAULTS.model,
    apiKey: process.env.TSFORGE_API_KEY,
  };
}

/** Resolve the model to use NOW: explicit TSFORGE_* env wins (escape hatch),
 *  else the registry's active entry. Returns the display name + the entry. */
export async function resolveActiveModel(): Promise<{
  name: string;
  entry: IModelEntry;
}> {
  const env = envModelEntry();

  if (env !== undefined) {
    return { name: "env", entry: env };
  }

  const cfg = await loadModelsConfig();

  return { name: cfg.active, entry: cfg.models[cfg.active] ?? QWEN_LOCAL };
}
