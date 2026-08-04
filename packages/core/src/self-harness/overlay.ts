/**
 * The harness overlay — the unit of change for the Self-Harness loop.
 * h_t = base harness + overlay; a candidate edit is one more JSON patch.
 *
 * Runtime resolution (sync, cached — the injection points in prompt/ttsr/agent
 * loading are hot paths on the base harness and must stay byte-identical when
 * no overlay is active):
 *   1. `TSFORGE_SELF_HARNESS_OVERLAY=<path>` — explicit, used by the validator
 *      to test a candidate. Wins.
 *   2. `~/.tsforge/self-harness/<model-slug>/overlay.json` — the promoted
 *      per-model overlay a human installed by merging the PR diff.
 *   3. Neither → null (base harness, unchanged behavior).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../lib/guards";
import { parseProjectRules } from "../loop/ttsr";
import { parseModelsConfig } from "../models-config";
import {
  PROMPT_BLOCK_NAMES,
  type IAgentSpecOverride,
  type IHarnessOverlay,
  type IOverlayPatch,
  type IProcedureCardEdit,
  type IToolOverride,
  type IPromptBlockEdit,
  type PromptBlockName,
} from "./self-harness.types";

export function emptyOverlay(): IHarnessOverlay {
  return {
    version: 1,
    ttsrRules: [],
    agentSpecOverrides: [],
    promptBlocks: {},
    procedureCards: {},
    toolOverrides: [],
  };
}

/** A tool edit is only meaningful with an id; everything else is optional, and
 *  a stray field is dropped rather than carried into the live harness. */
function parseToolOverride(value: unknown): IToolOverride | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    return null;
  }

  const override: { id: string; description?: string; enabled?: boolean } = {
    id: value.id,
  };

  if (typeof value.description === "string") {
    override.description = value.description;
  }

  if (typeof value.enabled === "boolean") {
    override.enabled = value.enabled;
  }

  return override;
}

function parseAgentOverride(value: unknown): IAgentSpecOverride | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }

  const override: {
    id: string;
    systemPrompt?: string;
    task?: string;
    maxTurns?: number;
  } = { id: value.id };

  if (typeof value.systemPrompt === "string") {
    override.systemPrompt = value.systemPrompt;
  }

  if (typeof value.task === "string") {
    override.task = value.task;
  }

  if (
    typeof value.maxTurns === "number" &&
    Number.isInteger(value.maxTurns) &&
    value.maxTurns > 0
  ) {
    override.maxTurns = value.maxTurns;
  }

  return override;
}

const BLOCK_NAMES: ReadonlySet<string> = new Set(PROMPT_BLOCK_NAMES);

function isBlockName(value: string): value is PromptBlockName {
  return BLOCK_NAMES.has(value);
}

function parseBlockEdit(value: unknown): IPromptBlockEdit | null {
  if (
    !isRecord(value) ||
    (value.mode !== "append" && value.mode !== "replace") ||
    typeof value.text !== "string" ||
    value.text.length === 0
  ) {
    return null;
  }

  return { mode: value.mode, text: value.text };
}

function parsePromptBlocks(
  value: unknown
): Partial<Record<PromptBlockName, IPromptBlockEdit>> {
  const blocks: Partial<Record<PromptBlockName, IPromptBlockEdit>> = {};

  if (!isRecord(value)) {
    return blocks;
  }

  for (const [name, raw] of Object.entries(value)) {
    const edit = parseBlockEdit(raw);

    if (isBlockName(name) && edit !== null) {
      blocks[name] = edit;
    }
  }

  return blocks;
}

const CARD_FIELDS = ["what", "bad", "good", "procedure"] as const;

function parseCardEdit(value: unknown): IProcedureCardEdit | null {
  if (!isRecord(value)) {
    return null;
  }

  const card: {
    what?: string;
    bad?: string;
    good?: string;
    procedure?: string;
  } = {};

  for (const field of CARD_FIELDS) {
    const raw = value[field];

    if (typeof raw === "string" && raw.length > 0) {
      card[field] = raw;
    }
  }

  return Object.keys(card).length > 0 ? card : null;
}

function parseProcedureCards(
  value: unknown
): Record<string, IProcedureCardEdit> {
  const cards: Record<string, IProcedureCardEdit> = {};

  if (!isRecord(value)) {
    return cards;
  }

  for (const [rule, raw] of Object.entries(value)) {
    const card = parseCardEdit(raw);

    if (card !== null) {
      cards[rule] = card;
    }
  }

  return cards;
}

/** Validate one parsed JSON value into an overlay. Invalid entries drop
 *  (warn-and-drop is the house loader style — a malformed overlay degrades to
 *  "less overlay", never a crash); a non-object degrades to null. */
export function parseOverlay(value: unknown): IHarnessOverlay | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    version: 1,
    // Reuse the project-rules validator so overlay TTSR rules obey exactly the
    // same schema as hand-authored .tsforge/rules.json ones.
    ttsrRules: parseProjectRules(JSON.stringify(value.ttsrRules ?? [])),
    agentSpecOverrides: Array.isArray(value.agentSpecOverrides)
      ? value.agentSpecOverrides
          .map(parseAgentOverride)
          .filter((o): o is IAgentSpecOverride => o !== null)
      : [],
    promptBlocks: parsePromptBlocks(value.promptBlocks),
    procedureCards: parseProcedureCards(value.procedureCards),
    toolOverrides: Array.isArray(value.toolOverrides)
      ? value.toolOverrides
          .map(parseToolOverride)
          .filter((o): o is IToolOverride => o !== null)
      : [],
  };
}

/** Compose two edits to the same prompt block: a replace supersedes what came
 *  before it; an append stacks below the existing edit. */
function composeBlockEdit(
  base: IPromptBlockEdit | undefined,
  patch: IPromptBlockEdit
): IPromptBlockEdit {
  if (patch.mode === "replace" || base === undefined) {
    return patch;
  }

  return { mode: base.mode, text: `${base.text}\n${patch.text}` };
}

/** Merge a candidate patch onto an overlay (both already validated). TTSR
 *  rules dedupe by name with the patch winning; agent overrides merge by id
 *  field-wise; prompt blocks compose (see composeBlockEdit); procedure cards
 *  merge field-wise per rule. */
export function mergeOverlay(
  base: IHarnessOverlay,
  patch: IOverlayPatch
): IHarnessOverlay {
  const patchRuleNames = new Set((patch.ttsrRules ?? []).map((r) => r.name));
  const ttsrRules = [
    ...base.ttsrRules.filter((r) => !patchRuleNames.has(r.name)),
    ...(patch.ttsrRules ?? []),
  ];

  const overridesById = new Map(base.agentSpecOverrides.map((o) => [o.id, o]));

  for (const o of patch.agentSpecOverrides ?? []) {
    overridesById.set(o.id, { ...overridesById.get(o.id), ...o });
  }

  const promptBlocks = { ...base.promptBlocks };

  for (const [name, edit] of Object.entries(patch.promptBlocks ?? {})) {
    if (isBlockName(name)) {
      promptBlocks[name] = composeBlockEdit(promptBlocks[name], edit);
    }
  }

  const procedureCards = { ...base.procedureCards };

  for (const [rule, card] of Object.entries(patch.procedureCards ?? {})) {
    procedureCards[rule] = { ...procedureCards[rule], ...card };
  }

  const toolsById = new Map(base.toolOverrides.map((o) => [o.id, o]));

  for (const o of patch.toolOverrides ?? []) {
    toolsById.set(o.id, { ...toolsById.get(o.id), ...o });
  }

  return {
    version: 1,
    ttsrRules,
    agentSpecOverrides: [...overridesById.values()],
    promptBlocks,
    procedureCards,
    toolOverrides: [...toolsById.values()],
  };
}

/** True when a patch changes no editable surface — such a candidate is
 *  rejected outright (paper §3.4: validation rejects proposals that modify no
 *  editable surface). */
export function isEmptyPatch(patch: IOverlayPatch): boolean {
  return (
    (patch.ttsrRules ?? []).length === 0 &&
    (patch.agentSpecOverrides ?? []).length === 0 &&
    Object.keys(patch.promptBlocks ?? {}).length === 0 &&
    Object.keys(patch.procedureCards ?? {}).length === 0 &&
    (patch.toolOverrides ?? []).length === 0
  );
}

/** Filesystem-safe slug of a model id ("deepseek-ai/DeepSeek-V4-Flash" →
 *  "deepseek-ai-deepseek-v4-flash"). */
export function modelSlug(modelId: string): string {
  const slug = modelId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

  return slug.length === 0 ? "model" : slug;
}

function homeBase(): string {
  return process.env.TSFORGE_HOME ?? homedir();
}

/** The promoted-overlay path for a model id. */
export function overlayPathFor(modelId: string): string {
  return join(
    homeBase(),
    ".tsforge",
    "self-harness",
    modelSlug(modelId),
    "overlay.json"
  );
}

/** The active model's id, resolved synchronously (env escape hatch first,
 *  then the registry's active entry) — mirrors resolveActiveModel() without
 *  the async file API so the hot-path injection points can call it. */
function activeModelIdSync(): string | null {
  const envModel = process.env.TSFORGE_MODEL;

  if (envModel !== undefined && envModel.length > 0) {
    return envModel;
  }

  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(homeBase(), ".tsforge", "models.json"), "utf8")
    );
    const cfg = parseModelsConfig(raw);

    return cfg.models[cfg.active]?.model ?? null;
  } catch {
    return null;
  }
}

function readOverlayFile(path: string): IHarnessOverlay | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));

    return parseOverlay(raw);
  } catch {
    return null;
  }
}

let cached: IHarnessOverlay | null = null;
let cacheKey: string | null = null;

/** The overlay in effect for this process, or null (base harness). Cached per
 *  resolved source so repeated prompt builds don't re-read disk; the cache
 *  key includes the env override so tests and the validator can flip it. */
export function activeOverlay(): IHarnessOverlay | null {
  const envPath = process.env.TSFORGE_SELF_HARNESS_OVERLAY;
  const key = envPath ?? `model:${process.env.TSFORGE_MODEL ?? "registry"}`;

  if (cacheKey === key) {
    return cached;
  }

  if (envPath !== undefined && envPath.length > 0) {
    cached = readOverlayFile(envPath);
  } else {
    const modelId = activeModelIdSync();

    cached = modelId === null ? null : readOverlayFile(overlayPathFor(modelId));
  }

  cacheKey = key;

  return cached;
}

/** Drop the cached overlay (tests, and the validator between candidates). */
export function resetOverlayCache(): void {
  cached = null;
  cacheKey = null;
}
