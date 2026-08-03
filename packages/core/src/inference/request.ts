import type {
  IChatMessage,
  ICompleteOptions,
  IOpenAICompatibleConfig,
} from "./inference.types";
import type { IReasoningProfile, ReasoningStyle } from "./reasoning-profile";
import {
  DEFAULT_TOKEN_CAP,
  REASONING_PRESETS,
  isReasoningProfile,
  isReasoningStyle,
  setPath,
} from "./reasoning-profile";
import { PROVIDER_LIMITS } from "./inference.constants";
import { toWire } from "./wire";

/** Interpolate `${VAR}` references from `env` into a string (missing → ""). */
function interpolateEnv(
  value: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  return value.replace(
    /\$\{([A-Za-z0-9_]+)\}/g,
    (_m: string, name: string) => env[name] ?? ""
  );
}

/** True when the endpoint requires thinking pinned to the session's first value
 *  (DeepSeek's cloud API 400s if it flips mid-conversation). Declared by the
 *  profile, so a new endpoint with the same constraint needs no code change. */
export function latchesThinking(cfg: IOpenAICompatibleConfig): boolean {
  return profile(cfg).latchThinking === true;
}

/** Resolve the endpoint's reasoning profile: an explicit object wins, a preset
 *  name expands, and an absent value falls back to auto-detection. */
export function profile(cfg: IOpenAICompatibleConfig): IReasoningProfile {
  const declared = cfg.reasoning;

  if (isReasoningStyle(declared)) {
    return REASONING_PRESETS[declared];
  }

  if (isReasoningProfile(declared)) {
    return declared;
  }

  // Anything else — undefined, JSON `null`, a typo'd preset name, a malformed
  // object — falls back to auto-detection. models-config rejects these loudly
  // at load; this is the last line of defence so a hand-edited registry cannot
  // crash a live turn (JSON null is NOT undefined and used to throw here).
  return REASONING_PRESETS[autoPreset(cfg)];
}

/** Best-effort preset for an entry that declared nothing. Only a convenience:
 *  anything this guesses wrong is fixed by declaring `reasoning` explicitly. */
function autoPreset(cfg: IOpenAICompatibleConfig): ReasoningStyle {
  // Auto-detect DeepSeek when not explicitly configured, so its thinking-mode
  // round-trip works out of the box: DeepSeek requires each prior assistant
  // turn's `reasoning_content` replayed, and 400s otherwise ("The
  // reasoning_content in the thinking mode must be passed back to the API").
  // Without this, a DeepSeek model added with just { baseUrl, model } gets the
  // `qwen` default, which strips reasoning_content on replay → that 400.
  if (`${cfg.baseUrl} ${cfg.model}`.toLowerCase().includes("deepseek")) {
    // ...but a SELF-HOSTED vLLM serving a DeepSeek checkpoint speaks a different
    // dialect: it reads `chat_template_kwargs.thinking` and silently ignores
    // `thinking:{type}`. Classifying it as `deepseek` makes thinking
    // UNCONTROLLABLE (the field is accepted and does nothing) and latches it for
    // the session. Only reclassify on a PRIVATE address, which is unambiguous
    // evidence of self-hosting — a public hostname may be a reverse proxy in
    // front of DeepSeek cloud, which still needs the cloud dialect and the
    // reasoning_content replay.
    return isPrivateHost(cfg.baseUrl) ? "deepseek-local" : "deepseek";
  }

  return "qwen";
}

/** A structural copy, so a value taken from a shared preset never enters the
 *  request body by reference. Primitives pass through untouched. */
function detach(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? structuredClone(value)
    : value;
}

/** Every profile-driven field — the token cap plus the reasoning controls —
 *  written into ONE object.
 *
 *  These must share a target. Built separately and shallow-spread, two paths
 *  under a common parent would clobber each other: `tokenCap:
 *  "params.output_limit"` with `effort: "params.reasoning.level"` produces two
 *  objects each holding a different `params`, and the later spread wins, so a
 *  field is silently dropped.
 *
 *  A control the profile omits is a control the endpoint does not have, so
 *  nothing is sent for it — that is what stops a field being accepted and
 *  ignored. Per-call options override config defaults. */
function profileFields(
  cfg: IOpenAICompatibleConfig,
  opts: ICompleteOptions
): Record<string, unknown> {
  const p = profile(cfg);
  const body: Record<string, unknown> = {};
  const effort = opts.reasoningEffort ?? cfg.reasoningEffort;

  // A NaN/Infinity maxTokens (bad config/env) would JSON.stringify to `null`,
  // which a server reads as an explicit choice, not "unset" — fall back to the
  // provider default instead (matches the temperature/repetitionPenalty guard).
  const configured = cfg.maxTokens;

  setPath(
    body,
    p.tokenCap ?? DEFAULT_TOKEN_CAP,
    configured !== undefined && Number.isFinite(configured)
      ? configured
      : PROVIDER_LIMITS.maxTokens
  );

  if (p.thinking !== undefined && opts.enableThinking !== undefined) {
    const { path, onValue = true, offValue = false } = p.thinking;
    const value = opts.enableThinking ? onValue : offValue;

    // Copy before writing. `profile()` hands back the SHARED preset object
    // (Readonly is type-only), so putting `onValue` into the body by reference
    // would let a caller mutating the returned body corrupt the preset for
    // every later request in the process.
    setPath(body, path, detach(value));
  }

  if (p.effort !== undefined && effort !== undefined) {
    setPath(body, p.effort, effort);
  }

  // A NaN/Infinity budget would JSON.stringify to `null`, which a server reads
  // as an explicit choice rather than "unset".
  if (
    p.budget !== undefined &&
    opts.thinkingTokenBudget !== undefined &&
    Number.isFinite(opts.thinkingTokenBudget)
  ) {
    setPath(body, p.budget, opts.thinkingTokenBudget);
  }

  return body;
}

/** The `tools` (+ `tool_choice`) request fields. `tool_choice` is sent by default
 *  — it grammar-constrains the call to a well-formed schema instead of free-form
 *  text the harness would have to salvage — and is suppressed ONLY for the deepseek
 *  style on DeepSeek's CLOUD host, whose thinking API 400s on it (see
 *  `suppressesToolChoice`). No configuration needed for the common local case. */
function toolsBlock(
  cfg: IOpenAICompatibleConfig,
  opts: ICompleteOptions
): Record<string, unknown> {
  // No tools advertised → OMIT the `tools` field entirely (and with it `tool_choice`).
  // An EMPTY array is treated the same as undefined: vLLM/DeepSeek 400 on `tools: []`
  // ("`tools` must not be an empty array … omit the field entirely"), and the R1 Phase A
  // no-tools diagnosis call deliberately passes `[]` to force a genuinely tool-less turn.
  if (opts.tools === undefined || opts.tools.length === 0) {
    return {};
  }

  if (suppressesToolChoice(cfg)) {
    return { tools: opts.tools };
  }

  return { tools: opts.tools, tool_choice: opts.toolChoice ?? "auto" };
}

/** Whether to omit `tool_choice`. Precedence: the explicit `guidedDecoding`
 *  override, then the profile's own declaration, then auto-detection by host —
 *  only DeepSeek's CLOUD API (api.deepseek.com) 400s on an explicit
 *  `tool_choice`; a self-hosted endpoint accepts it and grammar-constrains the
 *  call, so it is sent. */
function suppressesToolChoice(cfg: IOpenAICompatibleConfig): boolean {
  const override = guidedOverride(cfg);

  if (override !== undefined) {
    return !override;
  }

  const declared = profile(cfg).omitToolChoice;

  if (declared !== undefined) {
    return declared;
  }

  // The host heuristic applies ONLY to the DeepSeek cloud dialect, preserving
  // the old `style === "deepseek"` gate: an entry that picks another dialect
  // against api.deepseek.com has opted out and must keep getting `tool_choice`.
  //
  // Keyed on HOW the dialect was chosen, not on object identity — comparing
  // against the shared preset would treat an equivalent hand-written profile as
  // a different dialect purely because it is a different object.
  return usesCloudDeepseekDialect(cfg) && isDeepSeekCloudHost(cfg.baseUrl);
}

/** True when this entry is on DeepSeek's cloud dialect: either it named the
 *  `deepseek` preset, or it declared nothing and auto-detection chose it. A
 *  custom profile is deliberately excluded — it has full control and should say
 *  `omitToolChoice` outright rather than inherit a vendor quirk by resemblance. */
function usesCloudDeepseekDialect(cfg: IOpenAICompatibleConfig): boolean {
  const declared = cfg.reasoning;

  if (declared === undefined) {
    return autoPreset(cfg) === "deepseek";
  }

  return declared === "deepseek";
}

/** Normalize the optional `guidedDecoding` override — tolerates a stringified
 *  boolean from a hand-edited models.json; undefined ⇒ auto-detect by host. */
function guidedOverride(cfg: IOpenAICompatibleConfig): boolean | undefined {
  const value: unknown = cfg.guidedDecoding;

  if (value === true || value === "true") {
    return true;
  }

  if (value === false || value === "false") {
    return false;
  }

  return undefined;
}

/** The first two octets of a dotted-quad IPv4 address, or of the embedded v4 in
 *  an IPv4-mapped IPv6 one. Returns null when `host` is neither. WHATWG URL
 *  normalizes `::ffff:192.168.1.9` to `::ffff:c0a8:109`, so the mapped form has
 *  to be read as hex: the first hextet packs both octets. */
function firstTwoOctets(host: string): [number, number] | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);

  if (v4 !== null) {
    return [Number(v4[1]), Number(v4[2])];
  }

  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/iu.exec(host);
  const high = mapped?.[1];

  if (high !== undefined) {
    const hextet = Number.parseInt(high, 16);

    return [(hextet >> 8) & 0xff, hextet & 0xff];
  }

  return null;
}

/** True when `baseUrl` points at a private/loopback address or a LAN-only TLD —
 *  i.e. something the user is self-hosting. Used to tell a local vLLM apart from
 *  a public endpoint (which may be a reverse proxy in front of a cloud API), so
 *  only the former gets the vLLM reasoning dialect. Scheme-less input is
 *  tolerated the same way `isDeepSeekCloudHost` tolerates it. */
function isPrivateHost(baseUrl: string): boolean {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(baseUrl)
    ? baseUrl
    : `https://${baseUrl}`;

  let host: string;

  try {
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (host === "localhost") {
    return true;
  }

  if (/\.(local|lan|internal|home|localdomain)$/u.test(host)) {
    return true;
  }

  // WHATWG URL keeps the brackets on an IPv6 literal (`http://[::1]` →
  // hostname `[::1]`), so strip them before matching.
  const bare = host.replace(/^\[|\]$/gu, "");

  // Gate the IPv6 range checks on the host actually BEING an IPv6 literal.
  // Without this, `/^f[cd]/` matches DNS names like `fda.gov` or
  // `fcm.example.com` and would wrongly mark a public proxy private.
  const isIpv6 = bare.includes(":");

  if (
    isIpv6 &&
    (bare === "::1" || // loopback
      /^f[cd]/u.test(bare) || // unique-local fc00::/7
      /^fe[89ab]/u.test(bare)) // link-local fe80::/10
  ) {
    return true;
  }

  // An IPv4-mapped address is private iff its v4 part is. WHATWG URL rewrites
  // `::ffff:192.168.1.9` into hex (`::ffff:c0a8:109`), so match that form too —
  // the dotted spelling never survives parsing.
  const octets = firstTwoOctets(bare);

  if (octets === null) {
    return false;
  }

  const [a, b] = octets;

  return (
    a === 127 || // loopback
    a === 10 || // 10/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64/10 (Tailscale et al)
  );
}

/** True for the DeepSeek CLOUD API host (api.deepseek.com / *.deepseek.com) — the
 *  only endpoint known to reject an explicit `tool_choice`. Tolerates a scheme-less
 *  baseUrl (e.g. `api.deepseek.com/v1` from a hand-edited config): without a scheme
 *  `new URL()` throws, which would miss the cloud host and wrongly SEND tool_choice
 *  — the exact 400 this guards against — so prepend `https://` before parsing. */
function isDeepSeekCloudHost(baseUrl: string): boolean {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(baseUrl)
    ? baseUrl
    : `https://${baseUrl}`;

  try {
    return /(^|\.)deepseek\.com$/iu.test(new URL(withScheme).hostname);
  } catch {
    return false;
  }
}

/** Build the request body object (pure). Field order keeps the qwen default
 *  byte-for-byte identical; `extraBody` is merged last so it can override
 *  anything for a fully custom provider. */
export function buildRequestBody(
  cfg: IOpenAICompatibleConfig,
  messages: IChatMessage[],
  opts: ICompleteOptions,
  streaming: boolean
): Record<string, unknown> {
  const p = profile(cfg);

  // Some endpoints reject `temperature` outright; everywhere else send it only
  // when set AND finite — a NaN/Infinity (bad config/env) would JSON.stringify
  // to `null`, which a server reads as an explicit choice, not "unset".
  const omitTemperature =
    p.omitTemperature === true ||
    opts.temperature === undefined ||
    !Number.isFinite(opts.temperature);

  // Only endpoints that declare it want each prior assistant turn's
  // `reasoning_content` replayed (DeepSeek's cloud API 400s without it).
  const includeReasoning = p.replayReasoning === true;

  return {
    model: cfg.model,
    messages: messages.map((m) => toWire(m, includeReasoning)),
    ...profileFields(cfg, opts),
    ...(omitTemperature ? {} : { temperature: opts.temperature }),
    ...(cfg.repetitionPenalty === undefined ||
    !Number.isFinite(cfg.repetitionPenalty)
      ? {}
      : { repetition_penalty: cfg.repetitionPenalty }),
    ...toolsBlock(cfg, opts),
    ...(streaming
      ? { stream: true, stream_options: { include_usage: true } }
      : {}),
    ...(cfg.extraBody ?? {}),
  };
}

/** Build request headers: JSON + Bearer auth (when a key is set) + any
 *  `extraHeaders` (with `${VAR}` interpolation), which can override the defaults. */
export function buildRequestHeaders(
  cfg: IOpenAICompatibleConfig,
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (cfg.apiKey !== undefined) {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }

  for (const [key, value] of Object.entries(cfg.extraHeaders ?? {})) {
    headers[key] = interpolateEnv(value, env);
  }

  return headers;
}

/** Normalize the chat-completions URL: trim trailing slashes and don't
 *  double-append when the baseUrl already ends with the path. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");

  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}
