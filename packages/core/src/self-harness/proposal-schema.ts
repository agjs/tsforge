import { PROMPT_BLOCK_NAMES } from "./self-harness.types";

/**
 * JSON Schema for one proposer response, so a runtime that supports guided
 * decoding (vLLM, SGLang, OpenAI) constrains generation to this shape.
 *
 * WHY THIS EXISTS: asking DeepSeek for "only a JSON object" lost four of six
 * candidates to `unparseable proposer response` in a single session — the
 * paper's proposal width K silently collapsed from 3 to 1, and no round ever
 * had enough candidates for one to clear the acceptance rule. Constraining the
 * decode makes the reply parse by construction instead of by luck.
 *
 * This schema is a MIRROR of `IOverlayPatch`, not the authority on it:
 * `parseOverlay` still validates every response, so a drift between the two
 * costs a wasted proposal, never an invalid edit. Keep it in step anyway.
 *
 * Deliberately NOT emitted as OpenAI `strict` mode: that subset demands every
 * property appear in `required`, which would force each candidate to touch all
 * four surfaces at once and destroy the minimality the paper requires.
 */

const TTSR_RULE = {
  type: "object",
  properties: {
    name: { type: "string" },
    condition: { type: "array", items: { type: "string" } },
    scope: { type: "string", enum: ["content", "tool-args", "both"] },
    fileGlobs: { type: "array", items: { type: "string" } },
    guidance: { type: "string" },
    repeatMode: { type: "string", enum: ["once", "cooldown"] },
    repeatGap: { type: "integer" },
  },
  required: ["name", "condition", "scope", "guidance", "repeatMode"],
} as const;

const AGENT_SPEC_OVERRIDE = {
  type: "object",
  properties: {
    id: { type: "string" },
    systemPrompt: { type: "string" },
    task: { type: "string" },
    maxTurns: { type: "integer" },
  },
  required: ["id"],
} as const;

const PROMPT_BLOCK_EDIT = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["append", "replace"] },
    text: { type: "string" },
  },
  required: ["mode", "text"],
} as const;

const PROCEDURE_CARD_EDIT = {
  type: "object",
  properties: {
    what: { type: "string" },
    bad: { type: "string" },
    good: { type: "string" },
    procedure: { type: "string" },
  },
} as const;

const TOOL_OVERRIDE = {
  type: "object",
  properties: {
    id: { type: "string" },
    description: { type: "string" },
    enabled: { type: "boolean" },
  },
  required: ["id"],
} as const;

/** The patch object — every surface optional, because a candidate must touch
 *  as few as possible. */
const OVERLAY_PATCH = {
  type: "object",
  properties: {
    toolOverrides: { type: "array", items: TOOL_OVERRIDE },
    ttsrRules: { type: "array", items: TTSR_RULE },
    agentSpecOverrides: { type: "array", items: AGENT_SPEC_OVERRIDE },
    promptBlocks: {
      type: "object",
      properties: Object.fromEntries(
        PROMPT_BLOCK_NAMES.map((name) => [name, PROMPT_BLOCK_EDIT])
      ),
      additionalProperties: false,
    },
    // Keyed by gate rule id (`TS2307`, `no-non-null-assertion`, …), which is an
    // open set — so the keys are unconstrained and only the values are shaped.
    procedureCards: {
      type: "object",
      additionalProperties: PROCEDURE_CARD_EDIT,
    },
  },
} as const;

/** The full response: the audit record the paper requires, plus the patch. */
export const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    targetPattern: { type: "string" },
    surface: {
      type: "string",
      enum: [
        "ttsrRules",
        "promptBlocks",
        "procedureCards",
        "agentSpecOverrides",
        "toolOverrides",
      ],
    },
    expectedEffect: { type: "string" },
    risks: { type: "string" },
    patch: OVERLAY_PATCH,
  },
  required: ["targetPattern", "surface", "expectedEffect", "risks", "patch"],
} as const;

export const PROPOSAL_SCHEMA_NAME = "harness_proposal";
