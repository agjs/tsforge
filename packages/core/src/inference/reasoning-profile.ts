/**
 * How an endpoint expresses reasoning ON THE WIRE, as data rather than as a
 * hardcoded vendor list.
 *
 * The harness has a handful of internal concepts — thinking on/off, effort,
 * token budget — and every endpoint spells them differently. Enumerating model
 * families in a union type does not scale: there are thousands of checkpoints,
 * the list is never complete, and each new one would need a code change and a
 * release to support.
 *
 * So an entry DECLARES its mapping. `reasoning` accepts either a preset name
 * (convenience for the common cases) or a full profile (anything else). Adding
 * support for a new model is a config edit.
 */

/** A boolean flag's location and the values written for on/off. */
export interface IWireFlag {
  /** Dot path into the request body, e.g. `chat_template_kwargs.thinking`. */
  path: string;
  /** Value written when the flag is ON. Default `true`. */
  onValue?: unknown;
  /** Value written when the flag is OFF. Default `false`. */
  offValue?: unknown;
}

/** A complete description of an endpoint's reasoning surface. Every field is
 *  optional: omitted means "this endpoint has no such control", and nothing is
 *  sent for it. */
export interface IReasoningProfile {
  /** Where the thinking toggle goes. Omit when the endpoint has none. */
  thinking?: IWireFlag;
  /** Dot path for reasoning effort; the caller's value is passed through. */
  effort?: string;
  /** Dot path for the reasoning-token budget. */
  budget?: string;
  /** Dot path for the output-token cap. Default `max_tokens`. */
  tokenCap?: string;
  /** Never send `temperature` (OpenAI o-series rejects it outright). */
  omitTemperature?: boolean;
  /** Never send `tool_choice`. There is no host fallback: a profile pointed at
   *  DeepSeek's cloud API must set this, or the call 400s on any turn with
   *  tools. The `deepseek` preset sets it, so the name and a copy of it behave
   *  the same. */
  omitToolChoice?: boolean;
  /** Replay each prior assistant turn's `reasoning_content`. DeepSeek's cloud
   *  thinking API 400s without it; nothing else wants it. */
  replayReasoning?: boolean;
  /** Pin thinking to the session's first value and never flip it. DeepSeek's
   *  cloud API 400s when it changes mid-conversation. */
  latchThinking?: boolean;
}

/** Shorthand names for the profiles people actually hit. These are ALIASES over
 *  `IReasoningProfile`, not special cases in the code path. */
export type ReasoningStyle =
  "qwen" | "deepseek" | "deepseek-local" | "openai" | "none";

export const REASONING_PRESETS: Readonly<
  Record<ReasoningStyle, IReasoningProfile>
> = {
  /** Qwen's chat template declares `enable_thinking`. */
  qwen: {
    thinking: { path: "chat_template_kwargs.enable_thinking" },
    budget: "thinking_token_budget",
  },

  /** DeepSeek's CLOUD API: a top-level object, plus three protocol quirks that
   *  are behavioural rather than cosmetic. Self-hosted DeepSeek resolves to
   *  `deepseek-local`, so this preset now means the cloud API unambiguously —
   *  which is why `omitToolChoice` rides here as DATA rather than being decided
   *  by a host check. That also makes the name and the object true aliases: a
   *  hand-written or spread copy behaves identically. */
  deepseek: {
    thinking: {
      path: "thinking",
      onValue: { type: "enabled" },
      offValue: { type: "disabled" },
    },
    effort: "reasoning_effort",
    // Its thinking API 400s on an explicit tool_choice. The model still gets
    // the tools and decides for itself.
    omitToolChoice: true,
    replayReasoning: true,
    latchThinking: true,
  },

  /** A DeepSeek checkpoint served by a template-driven runtime (vLLM, SGLang).
   *  `thinking` here is a kwarg of the DeepSeek-V4 CHAT TEMPLATE, which the
   *  runtime merely forwards — it is not a vLLM-wide field, which is why this
   *  is keyed to the model family and not to the server.
   *
   *  No `budget`: vLLM's V2 model runner answers `thinking_token_budget` with a
   *  400 ("not yet supported ... run with VLLM_USE_V2_MODEL_RUNNER=0"), and V2
   *  is the default. The field survived here because the unsupported-field
   *  learner retries without it, so every turn worked — at the cost of a wasted
   *  round trip per process and a 400 in the server log each time. Qwen keeps
   *  its `budget`; that path is served by runtimes that accept the field.
   *
   *  This is the default for the common case, not a claim that no DeepSeek
   *  server accepts the field. A deployment running the V1 runner
   *  (`VLLM_USE_V2_MODEL_RUNNER=0`) can have it back by setting `reasoning` to
   *  a full profile rather than this preset name — the learner can only remove
   *  a field, never restore one, so the preset is the only place to put it
   *  back. */
  "deepseek-local": {
    thinking: { path: "chat_template_kwargs.thinking" },
    effort: "chat_template_kwargs.reasoning_effort",
  },

  /** OpenAI o-series: effort only, renamed token cap, no temperature. */
  openai: {
    effort: "reasoning_effort",
    tokenCap: "max_completion_tokens",
    omitTemperature: true,
  },

  /** Endpoint exposes no reasoning controls. */
  none: {},
};

/** Recursively freeze, so a caller that gets a preset back from `profile()`
 *  cannot mutate it and corrupt every later request in the process. `Readonly`
 *  is type-only and does nothing at runtime. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const v of Object.values(value)) {
    deepFreeze(v);
  }

  return value;
}

deepFreeze(REASONING_PRESETS);

export function isReasoningStyle(value: unknown): value is ReasoningStyle {
  return typeof value === "string" && Object.hasOwn(REASONING_PRESETS, value);
}

/** Where the output-token cap goes when a profile does not say. Exported so the
 *  request builder and the overlap check cannot drift apart. */
export const DEFAULT_TOKEN_CAP = "max_tokens";

/** Top-level fields the request builder owns. A profile path may not target one
 *  or nest under one: `{"tokenCap":"messages"}` would replace the conversation,
 *  `{"thinking":{"path":"model"}}` the model id, and `temperature`/`tools`/
 *  `stream` would be silently overwritten by the normal fields spread after. */
const RESERVED_ROOTS = new Set([
  "model",
  "messages",
  "temperature",
  "repetition_penalty",
  "tools",
  "tool_choice",
  "stream",
  "stream_options",
]);

/** Path-valued profile keys. */
const PATH_KEYS = ["effort", "budget", "tokenCap"] as const;

/** Boolean-valued profile keys. */
const FLAG_KEYS = [
  "omitTemperature",
  "omitToolChoice",
  "replayReasoning",
  "latchThinking",
] as const;

/** Every key a profile may carry. Anything else is a typo, and a typo must not
 *  validate: `{"budegt": "..."}` would otherwise load fine and then silently
 *  send no budget at all. */
const PROFILE_KEYS = new Set<string>(["thinking", ...PATH_KEYS, ...FLAG_KEYS]);

/** Same rule one level down: `onValu` would otherwise validate and silently
 *  fall back to the default `true`. */
const WIRE_FLAG_KEYS = new Set<string>(["path", "onValue", "offValue"]);

/** True when one path is the same as, or nested under, another. Two such paths
 *  cannot both be written: `tokenCap: "params"` then
 *  `thinking: "params.enabled"` replaces the cap with an object, and the
 *  reverse order erases the nested field. Rejected at validation rather than
 *  silently dropping a control the user configured. */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/** True when `value` is usable as a profile. Config is hand-editable, so a
 *  wrong shape has to be rejected at the boundary rather than throwing deep in
 *  a request, or worse, being accepted and doing nothing. */
export function isReasoningProfile(value: unknown): value is IReasoningProfile {
  if (!isPlainObject(value)) {
    return false;
  }

  if (!Object.keys(value).every((k) => PROFILE_KEYS.has(k))) {
    return false;
  }

  if (!hasValidWireFlag(value) || !hasValidFlags(value)) {
    return false;
  }

  const paths = collectPaths(value);

  return paths !== null && !anyOverlap(paths);
}

/** The `thinking` member, when present, must be a wire flag with a safe path and
 *  no stray keys — `onValu` would otherwise validate and silently fall back to
 *  the default `true`. */
function hasValidWireFlag(value: Record<string, unknown>): boolean {
  const flag = value.thinking;

  if (flag === undefined) {
    return true;
  }

  return (
    isPlainObject(flag) &&
    typeof flag.path === "string" &&
    isSafePath(flag.path) &&
    Object.keys(flag).every((k) => WIRE_FLAG_KEYS.has(k))
  );
}

/** Every boolean member must actually be a boolean. */
function hasValidFlags(value: Record<string, unknown>): boolean {
  return FLAG_KEYS.every((key) => {
    const v = value[key];

    return v === undefined || typeof v === "boolean";
  });
}

/** Every path this profile will write, or null if any is malformed. Includes
 *  the DEFAULT token cap when unset, because it is written regardless — without
 *  it `{ "effort": "max_tokens" }` validates and then overwrites the output
 *  limit with an effort string. */
function collectPaths(value: Record<string, unknown>): string[] | null {
  const paths: string[] = [];
  const flag = value.thinking;

  if (isPlainObject(flag) && typeof flag.path === "string") {
    paths.push(flag.path);
  }

  for (const key of PATH_KEYS) {
    const path = value[key];

    if (path === undefined) {
      continue;
    }

    if (typeof path !== "string" || !isSafePath(path)) {
      return null;
    }

    paths.push(path);
  }

  if (value.tokenCap === undefined) {
    paths.push(DEFAULT_TOKEN_CAP);
  }

  return paths;
}

/** True when any two paths would clobber each other. */
function anyOverlap(paths: string[]): boolean {
  return paths.some((a, i) =>
    paths.slice(i + 1).some((b) => pathsOverlap(a, b))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Path segments that would escape the request body and reach into the
 *  prototype chain. A models.json is user-editable config, so a path like
 *  `__proto__.polluted` must not be able to write to Object.prototype. */
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** True when every segment of a dot path is present and safe to write, and the
 *  path does not target a field the request builder owns. */
export function isSafePath(path: string): boolean {
  if (path === "") {
    return false;
  }

  const parts = path.split(".");

  if (!parts.every((p) => p !== "" && !UNSAFE_SEGMENTS.has(p))) {
    return false;
  }

  return !RESERVED_ROOTS.has(parts[0] ?? "");
}

/** Write `value` at a dot path, creating intermediate objects. Mutates `target`
 *  and returns it, so several fields can be layered into one body fragment.
 *  A malformed or unsafe path is ignored rather than throwing — this runs on
 *  hand-edited config, and a bad path should not take down a live turn. */
export function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  if (typeof path !== "string" || !isSafePath(path)) {
    return target;
  }

  // isSafePath guarantees at least one non-empty segment, so pop() is defined.
  const parts = path.split(".");
  const last = parts.pop() ?? path;
  let node = target;

  for (const part of parts) {
    // Own properties only: an inherited value must never be descended into.
    const next = Object.hasOwn(node, part) ? node[part] : undefined;
    // Overwrite anything that isn't a plain object: a scalar or array sitting
    // at an intermediate path can't be descended into, and silently bailing
    // would drop the field the caller asked for.
    const child = isPlainObject(next) ? next : {};

    node[part] = child;
    node = child;
  }

  node[last] = value;

  return target;
}
