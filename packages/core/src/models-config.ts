import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { isRecord } from "./lib/guards";
import { PROVIDER_DEFAULTS } from "./inference/inference.constants";
import type {
  IReasoningProfile,
  ReasoningStyle,
} from "./inference/inference.types";
import {
  REASONING_PRESETS,
  isReasoningProfile,
  isReasoningStyle,
} from "./inference/reasoning-profile";

/**
 * The model registry — `~/.tsforge/models.json`, the central place a user
 * configures N model endpoints and switches between them with `/model`. Mirrors
 * the sessions/logs layout (under `$TSFORGE_HOME` if set, else the home dir).
 * Loading is read-only and falls back to the built-in local default when no
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
  /** How this endpoint expresses reasoning on the wire. Either a preset NAME
   *  (`qwen` | `deepseek` | `deepseek-local` | `openai` | `none`) or a full
   *  `IReasoningProfile` declaring the field paths itself — the latter is what
   *  makes an arbitrary model supportable by config rather than by a code change.
   *
   *  Omitted → auto-detected: a "deepseek" model/url resolves to `deepseek-local`
   *  on a PRIVATE address (loopback, RFC1918, CGNAT, IPv6 ULA/link-local,
   *  .local/.lan/.internal/.home/.localdomain) and to `deepseek` on any public
   *  one, since a public host may be a reverse proxy in front of DeepSeek cloud.
   *  Declare it explicitly for a self-host on a public address, or for a
   *  single-label hostname (e.g. `http://spark2:8888`), which is not treated as
   *  private because it is indistinguishable from a proxy alias.
   *
   *  Validated at load — an unknown name or malformed profile throws. */
  reasoning?: ReasoningStyle | IReasoningProfile;
  /** Reasoning effort for `deepseek`/`deepseek-local`/`openai` styles. */
  reasoningEffort?: "low" | "medium" | "high";
  /** OPTIONAL override for guided-decoding (structured tool-call) support.
   *  Normally leave unset — whether `tool_choice` is sent comes from the reasoning
   *  profile's `omitToolChoice`. Set true/false to force it either way. */
  guidedDecoding?: boolean;
  /** Arbitrary fields merged into the request body (override built-ins) — the
   *  escape hatch for any provider-specific param. */
  extraBody?: Record<string, unknown>;
  /** Arbitrary request headers (e.g. a non-Bearer auth scheme); `${VAR}` values
   *  are interpolated from the environment. */
  extraHeaders?: Record<string, string>;
  /** For an `imageGen` capability entry: which wire shape the endpoint speaks.
   *  `chat-modalities` (default) posts `/chat/completions` with
   *  `modalities:["image","text"]` (OpenRouter-style); `images-generations`
   *  posts the OpenAI `/images/generations` shape. Ignored for chat/vision. */
  imageApi?: ImageApi;
}

/** How an image-generation endpoint is called on the wire. */
export type ImageApi = "chat-modalities" | "images-generations";

/** The extra capabilities the harness can borrow from a separate backend when
 *  the primary chat model can't do them. Each value NAMES an entry in `models`,
 *  so a capability reuses the same endpoint config (key resolution, headers) as
 *  any chat model. Absent → the capability (and its tool/UX) stays off. */
export const CAPABILITY_NAMES = [
  "vision",
  "imageGen",
  "expert",
  "planner",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export interface IModelsConfig {
  /** Name of the active entry — always a key of `models`. */
  active: string;
  models: Record<string, IModelEntry>;
  /** Optional capability→entry-name routing. e.g. `{ vision: "openrouter-vlm" }`. */
  capabilities?: Partial<Record<CapabilityName, string>>;
  /** Optional panel of model + binary reviewers for collaborative review. */
  reviewPanel?: IReviewPanel;
}

export interface IReviewerModel {
  kind: "model";
  id: string;
  /** Names a key in `models` — reuses its baseUrl/key/headers. */
  entry: string;
}

export type BinaryInputMode = "stdin" | "arg" | "tempfile";
export type BinaryParseMode = "json-fence" | "raw";

export interface IReviewerBinary {
  kind: "binary";
  id: string;
  argv: string[];
  input: BinaryInputMode;
  timeoutMs: number;
  parse: BinaryParseMode;
  /**
   * Which `models` entry this binary is a front for, when it is one.
   *
   * A binary reviewer is an opaque command — nothing in `argv` says which model
   * answers, so the independence check that skips a MODEL reviewer sharing the
   * builder's host and id cannot see a binary at all. A CLI pointed at the same
   * model as the builder therefore counted as an independent vote, and a panel
   * of one model reviewing its own work is a panel that agrees with itself.
   *
   * Declaring it makes that checkable. Left unset the binary is kept, because
   * there is nothing to compare and refusing every undeclared CLI would disable
   * working panels — but then its independence is asserted by whoever wrote the
   * config rather than verified here.
   */
  fronts?: string;
}

export type IReviewer = IReviewerModel | IReviewerBinary;

export interface IReviewPanel {
  minReviewers: number;
  reviewers: IReviewer[];
}

/** The built-in local default entry — matches PROVIDER_DEFAULTS so an absent
 *  registry behaves exactly like the current env-default path. The reasoning
 *  dialect is auto-detected from the model name (see request.ts). */
const LOCAL_DEFAULT: IModelEntry = {
  baseUrl: PROVIDER_DEFAULTS.baseUrl,
  model: PROVIDER_DEFAULTS.model,
  thinking: true,
};

/** The default registry used when no models.json exists yet. */
export function defaultModelsConfig(): IModelsConfig {
  return { active: "local", models: { local: LOCAL_DEFAULT } };
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
 *  contract. Runs on the raw record so the type check is real (post-narrow it would
 *  be dead). These are token COUNTS, so require a positive integer — that also rules
 *  out a float / NaN / Infinity slipping through `typeof === "number"`. */
function assertNumericFields(name: string, entry: unknown): void {
  if (!isRecord(entry)) {
    return; // isModelEntry rejects non-records with its own message
  }

  for (const field of ["maxTokens", "contextWindow"]) {
    const value = entry[field];

    if (
      value !== undefined &&
      (!Number.isInteger(value) || Number(value) <= 0)
    ) {
      throw new Error(
        `models.json: model "${name}" field ${field} must be a positive integer`
      );
    }
  }
}

/** A hand-edited `imageApi` typo (e.g. "chat-modality") would otherwise pass the
 *  baseUrl/model-only guard and silently fall back to the chat-modalities wire
 *  path in image-gen — fail loud with the valid options instead. */
function assertImageApi(name: string, entry: unknown): void {
  if (!isRecord(entry) || entry.imageApi === undefined) {
    return;
  }

  if (
    entry.imageApi !== "chat-modalities" &&
    entry.imageApi !== "images-generations"
  ) {
    throw new Error(
      `models.json: model "${name}" imageApi must be "chat-modalities" or "images-generations"`
    );
  }
}

/** `reasoning` is either a known preset NAME or a well-formed profile object.
 *  Anything else is rejected here, at the JSON boundary: a typo'd preset would
 *  otherwise behave as an empty profile (silently sending no reasoning fields),
 *  and `null` or a malformed profile would surface as a TypeError mid-turn.
 *  Matches the fail-loud contract of the maxTokens/imageApi guards. */
function assertReasoning(name: string, entry: unknown): void {
  if (!isRecord(entry) || entry.reasoning === undefined) {
    return;
  }

  const value = entry.reasoning;

  if (isReasoningStyle(value) || isReasoningProfile(value)) {
    return;
  }

  const presets = Object.keys(REASONING_PRESETS).join(", ");

  throw new Error(
    `models.json: model "${name}" reasoning must be one of [${presets}] ` +
      `or a profile object { thinking?: { path }, effort?, budget?, tokenCap?, ` +
      `omitTemperature?, omitToolChoice?, replayReasoning?, latchThinking? } ` +
      `with string dot-paths (no __proto__/constructor/prototype segments)`
  );
}

function isInputMode(v: unknown): v is BinaryInputMode {
  return v === "stdin" || v === "arg" || v === "tempfile";
}

function isParseMode(v: unknown): v is BinaryParseMode {
  return v === "json-fence" || v === "raw";
}

/**
 * A model entry by name — OWN properties only.
 *
 * The registry is a PLAIN object (see parseModelsConfig for why Object.create(null)
 * was tried and dropped), so it inherits from Object.prototype and this is load
 * bearing everywhere, not belt-and-braces. A caller-supplied `IModelsConfig` —
 * `resolvePanel` and friends are exported and take one — has the same shape:
 * `models["constructor"]` resolves to a function rather than undefined, so a
 * plain index read reports "yes, that model exists" and hands on something that
 * is not a model.
 */
export function modelByName(
  models: Record<string, IModelEntry>,
  name: string
): IModelEntry | undefined {
  return Object.hasOwn(models, name) ? models[name] : undefined;
}

function parseModelReviewer(
  raw: Record<string, unknown>,
  models: Record<string, IModelEntry>
): IReviewerModel {
  if (typeof raw.id !== "string" || typeof raw.entry !== "string") {
    throw new Error("models.json: model reviewer needs { id, entry }");
  }

  if (modelByName(models, raw.entry) === undefined) {
    throw new Error(
      `models.json: reviewer entry "${raw.entry}" is not a configured model`
    );
  }

  // A `fronts` here is a declaration that will never be read: only the binary
  // path consults it, so a model reviewer carrying one looks annotated and is
  // not. That is the same silent-declaration failure `fronts` exists to remove.
  if (raw.fronts !== undefined) {
    throw new Error(
      'models.json: "fronts" belongs on a binary reviewer — a model reviewer declares its model with "entry"'
    );
  }

  return { kind: "model", id: raw.id, entry: raw.entry };
}

function parseBinaryReviewer(
  raw: Record<string, unknown>,
  models: Record<string, IModelEntry>
): IReviewerBinary {
  const argv = raw.argv;

  if (typeof raw.id !== "string" || !Array.isArray(argv) || argv.length === 0) {
    throw new Error(
      "models.json: binary reviewer needs { id, argv (non-empty) }"
    );
  }

  if (!argv.every((a): a is string => typeof a === "string")) {
    throw new Error("models.json: binary reviewer argv must be all strings");
  }

  if (
    !isInputMode(raw.input) ||
    !isParseMode(raw.parse) ||
    typeof raw.timeoutMs !== "number"
  ) {
    throw new Error(
      "models.json: binary reviewer needs { input, parse, timeoutMs }"
    );
  }

  return {
    kind: "binary",
    id: raw.id,
    argv,
    input: raw.input,
    timeoutMs: raw.timeoutMs,
    parse: raw.parse,
    ...frontsOf(raw, models),
  };
}

/**
 * The optional `fronts` declaration, REJECTING a present-but-wrong value.
 *
 * Silently dropping a non-string turns a typo into an unchecked reviewer: the
 * author believes they declared independence, the parser discards it, and the
 * binary takes the undeclared path and counts as an independent vote anyway.
 * That is the exact silent failure this field exists to remove, so a malformed
 * one is a config error like any other.
 */
function frontsOf(
  raw: Record<string, unknown>,
  models: Record<string, IModelEntry>
): { fronts?: string } {
  if (raw.fronts === undefined) {
    return {};
  }

  if (typeof raw.fronts !== "string" || raw.fronts.length === 0) {
    throw new Error(
      'models.json: binary reviewer "fronts" must be a non-empty models entry name'
    );
  }

  // Checked against the registry, exactly as the model path checks `entry`. A
  // well-formed typo — "buidler" — would otherwise parse fine and be discovered
  // only at resolve time, as a reviewer quietly skipped mid-run.
  if (modelByName(models, raw.fronts) === undefined) {
    throw new Error(
      `models.json: binary reviewer "fronts" names "${raw.fronts}", which is not a configured model`
    );
  }

  return { fronts: raw.fronts };
}

function parseReviewer(
  raw: unknown,
  models: Record<string, IModelEntry>
): IReviewer {
  if (!isRecord(raw)) {
    throw new Error("models.json: each reviewer must be an object");
  }

  if (raw.kind === "model") {
    return parseModelReviewer(raw, models);
  }

  if (raw.kind === "binary") {
    return parseBinaryReviewer(raw, models);
  }

  throw new Error('models.json: reviewer kind must be "model" or "binary"');
}

function parseReviewPanel(
  raw: unknown,
  models: Record<string, IModelEntry>
): IReviewPanel | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!isRecord(raw) || !Array.isArray(raw.reviewers)) {
    throw new Error(
      "models.json: reviewPanel must be { minReviewers, reviewers[] }"
    );
  }

  const minReviewers =
    typeof raw.minReviewers === "number" ? raw.minReviewers : 2;
  const reviewers = raw.reviewers.map((r) => parseReviewer(r, models));

  return { minReviewers, reviewers };
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

  // A plain object, deliberately. `Object.create(null)` would remove the
  // inherited names structurally and was the better shape, but it returns `any`
  // — so adopting it means either a forbidden `as` cast or an eslint-disable at
  // the heart of config parsing, and neither is worth it here. The two holes it
  // would have closed are closed anyway: `__proto__` is refused as a name just
  // below, which is the only key whose ASSIGNMENT does something other than add
  // a property, and every read goes through `modelByName`.
  const models: Record<string, IModelEntry> = {};

  for (const [name, entry] of Object.entries(raw.models)) {
    if (!isModelEntry(entry)) {
      throw new Error(
        `models.json: model "${name}" needs at least { baseUrl, model }`
      );
    }

    // Rejected rather than stored. A null-prototype registry could hold it
    // safely, but `saveModelsConfig` serialises with JSON.stringify and would
    // write a literal `"__proto__"` key back into models.json — a file other
    // tools parse, where a plain `JSON.parse` + spread poisons whatever reads
    // it. Refusing the name costs a user nothing and stops us emitting a
    // hazard.
    if (name === "__proto__") {
      throw new Error('models.json: "__proto__" is not a usable model name');
    }

    assertNumericFields(name, entry);
    assertImageApi(name, entry);
    assertReasoning(name, entry);
    models[name] = entry;
  }

  if (modelByName(models, raw.active) === undefined) {
    throw new Error(
      `models.json: active "${raw.active}" is not one of: ${Object.keys(models).join(", ")}`
    );
  }

  const capabilities = parseCapabilities(raw.capabilities, models);
  const reviewPanel = parseReviewPanel(raw.reviewPanel, models);

  const withCaps =
    capabilities === undefined
      ? { active: raw.active, models }
      : { active: raw.active, models, capabilities };

  return reviewPanel === undefined ? withCaps : { ...withCaps, reviewPanel };
}

/** Validate the optional `capabilities` block: known keys only, each pointing at
 *  a real model entry. Fail loud (this file's contract) so a typo'd capability
 *  name or a dangling entry reference is caught at load, not at first image use. */
function parseCapabilities(
  raw: unknown,
  models: Record<string, IModelEntry>
): Partial<Record<CapabilityName, string>> | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!isRecord(raw)) {
    throw new Error("models.json: capabilities must be an object");
  }

  const out: Partial<Record<CapabilityName, string>> = {};

  const capabilityNames: ReadonlySet<string> = new Set(CAPABILITY_NAMES);
  const isCapabilityName = (cap: string): cap is CapabilityName =>
    capabilityNames.has(cap);

  for (const [cap, target] of Object.entries(raw)) {
    if (!isCapabilityName(cap)) {
      throw new Error(
        `models.json: unknown capability "${cap}" — expected ${CAPABILITY_NAMES.join(", ")}`
      );
    }

    if (
      typeof target !== "string" ||
      modelByName(models, target) === undefined
    ) {
      throw new Error(
        `models.json: capability "${cap}" must name a model: ${Object.keys(models).join(", ")}`
      );
    }

    out[cap] = target;
  }

  return out;
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
/** Names that must never reach the file, whatever built the config. */
function assertSafeNames(cfg: IModelsConfig): void {
  if (Object.hasOwn(cfg.models, "__proto__")) {
    throw new Error('models.json: "__proto__" is not a usable model name');
  }
}

export async function saveModelsConfig(cfg: IModelsConfig): Promise<void> {
  // Checked HERE as well as at parse. The reason for refusing the name is that
  // it must not reach the file — models.json is read by other tools, where a
  // plain parse-and-spread poisons whatever consumes it — and this function is
  // exported and takes a config the caller built, which the parser never saw.
  assertSafeNames(cfg);

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

  if (modelByName(cfg.models, name) === undefined) {
    throw new Error(
      `unknown model "${name}" — configured: ${Object.keys(cfg.models).join(", ")}`
    );
  }

  // Preserve everything else (notably the top-level `capabilities` block) — only
  // `active` changes. Spreading cfg avoids silently dropping vision/imageGen
  // routing on a `/model` switch.
  const next: IModelsConfig = { ...cfg, active: name };

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

  return {
    name: cfg.active,
    entry: modelByName(cfg.models, cfg.active) ?? LOCAL_DEFAULT,
  };
}

/** Resolve a model by its registry name, falling back to the active model when
 *  the name is unset or not in the registry. The seam for greenfield role routing
 *  (planner / work / evaluator): an unconfigured role transparently reuses the
 *  active model, so a single-endpoint setup still runs. Explicit TSFORGE_* env
 *  still wins (it overrides the whole registry), matching resolveActiveModel. */
export async function resolveModelByName(
  name: string | undefined
): Promise<{ name: string; entry: IModelEntry }> {
  const env = envModelEntry();

  if (env !== undefined) {
    return { name: name ?? "env", entry: env };
  }

  if (name === undefined || name.length === 0) {
    return resolveActiveModel();
  }

  const cfg = await loadModelsConfig();
  const entry = modelByName(cfg.models, name);

  return entry === undefined
    ? {
        name: cfg.active,
        entry: modelByName(cfg.models, cfg.active) ?? LOCAL_DEFAULT,
      }
    : { name, entry };
}

/** Resolve the backend for an extra capability (`vision`/`imageGen`), or `null`
 *  when none is configured (the capability's tool/UX then stays off — the
 *  primary chat model is never asked to do what it can't). Resolution order,
 *  most-specific first, so a one-off run needs no `models.json` edit:
 *    1. `TSFORGE_{VISION,IMAGE}_BASE_URL` (+ `_MODEL`, `_API_KEY`, `_API`) →
 *       a fully self-contained ad-hoc entry.
 *    2. `TSFORGE_{VISION,IMAGE}_MODEL` (without a base url) → names a registry
 *       entry to reuse.
 *    3. `models.json` `capabilities.{vision,imageGen}` → names a registry entry.
 *  This mirrors the env-wins-over-registry contract of resolveActiveModel. */
export async function resolveCapabilityModel(
  cap: CapabilityName
): Promise<{ name: string; entry: IModelEntry } | null> {
  const prefixByCap: Record<CapabilityName, string> = {
    vision: "TSFORGE_VISION",
    imageGen: "TSFORGE_IMAGE",
    expert: "TSFORGE_EXPERT",
    planner: "TSFORGE_PLANNER",
  };
  const prefix = prefixByCap[cap];
  const envBase = process.env[`${prefix}_BASE_URL`];
  const envModel = process.env[`${prefix}_MODEL`];

  if (envBase !== undefined && envBase.length > 0) {
    if (envModel === undefined || envModel.length === 0) {
      throw new Error(
        `${prefix}_BASE_URL is set but ${prefix}_MODEL is missing`
      );
    }

    const entry: IModelEntry = {
      baseUrl: envBase,
      model: envModel,
      apiKey: process.env[`${prefix}_API_KEY`],
    };

    if (cap === "imageGen") {
      const api = process.env[`${prefix}_API`];

      if (api === "chat-modalities" || api === "images-generations") {
        entry.imageApi = api;
      }
    }

    return { name: `env:${cap}`, entry };
  }

  const cfg = await loadModelsConfig();

  if (envModel !== undefined && envModel.length > 0) {
    const entry = modelByName(cfg.models, envModel);

    if (entry === undefined) {
      throw new Error(
        `${prefix}_MODEL "${envModel}" is not a configured model: ${Object.keys(cfg.models).join(", ")}`
      );
    }

    return { name: envModel, entry };
  }

  const target = cfg.capabilities?.[cap];
  const mapped =
    target === undefined ? undefined : modelByName(cfg.models, target);

  if (target !== undefined && mapped !== undefined) {
    return { name: target, entry: mapped };
  }

  return null;
}
