/**
 * The pure per-call decisions inside Session.askModel, extracted so the two
 * behaviours that MUST not regress silently — plan mode's read-only tool
 * filter and the adaptive thinking mode — have direct unit tests.
 */
import { READ_ONLY_TOOL_NAMES, TOOL_NAME } from "../agent";
import type { ITokenUsage } from "../inference";
import { clampRatio } from "../lib/ratio";
import type { ILoopEvent } from "./loop.types";

/** The minimal shape shared by advertised tools and MCP tool schemas. */
interface INamedTool {
  readonly function: { readonly name: string; readonly description?: string };
}

/** One harness-overlay edit to how an EXISTING tool is offered. */
interface IToolWiring {
  readonly id: string;
  readonly description?: string;
  readonly enabled?: boolean;
}

/**
 * The thinking mode for one model call. Precedence:
 * 1. A FORCED tool turn always thinks-off — the model already decided what to
 *    do, and thinking-on is a known source of prose-before-the-call malformed
 *    output; `required` + thinking-off is the cleanest tool call.
 * 2. While REPAIRING (gate errors outstanding) always think, so repair converges.
 * 3. Otherwise honour the per-send override, then the session config
 *    (undefined = let the provider default).
 */
export function selectThinking(opts: {
  forceNoThinking: boolean;
  repairing: boolean;
  activeThinking: boolean | undefined;
  configured: boolean | undefined;
}): boolean | undefined {
  if (opts.forceNoThinking) {
    return false;
  }

  if (opts.repairing) {
    return true;
  }

  return opts.activeThinking ?? opts.configured;
}

/**
 * The tools advertised for one model call. PLAN MODE advertises only the
 * read-only tools (+ `run`, whose handler enforces a read-only command
 * allowlist) — the model never sees a write tool. Filtered per call, so the
 * session's tool list is untouched and toggling the mode off restores the full
 * set with zero bookkeeping. MCP tools are external context sources (not
 * workspace writes), so they ride alongside the built-ins even in plan mode.
 */
export function offeredToolsFor<T extends INamedTool, U extends INamedTool>(
  tools: readonly T[],
  planMode: boolean,
  mcpSchemas: readonly U[],
  wiring: readonly IToolWiring[] = []
): (T | U)[] {
  const base = planMode
    ? tools.filter(
        (t) =>
          READ_ONLY_TOOL_NAMES.has(t.function.name) ||
          t.function.name === TOOL_NAME.run
      )
    : [...tools];

  const offered = mcpSchemas.length > 0 ? [...base, ...mcpSchemas] : base;

  return wiring.length > 0 ? applyToolWiring(offered, wiring) : offered;
}

/**
 * Apply the overlay's tool edits to the offered set.
 *
 * The paper puts `tools` in the editable harness file while holding the TOOL
 * SET itself constant across variants, and that asymmetry is the whole safety
 * story here: this can hide a tool or reword how one is described, never
 * introduce one. An id that names no offered tool does nothing — there is no
 * path by which a name grants capability.
 *
 * Hiding a tool the model needs is allowed and self-correcting: the pass rate
 * falls, the acceptance rule rejects the edit. That is the loop working, not a
 * hole in it.
 */
function applyToolWiring<T extends INamedTool>(
  offered: readonly T[],
  wiring: readonly IToolWiring[]
): T[] {
  const byId = new Map(wiring.map((w) => [w.id, w]));
  const result: T[] = [];

  for (const tool of offered) {
    const edit = byId.get(tool.function.name);

    if (edit === undefined) {
      result.push(tool);
      continue;
    }

    if (edit.enabled === false) {
      continue;
    }

    result.push(
      edit.description === undefined
        ? tool
        : {
            ...tool,
            function: { ...tool.function, description: edit.description },
          }
    );
  }

  return result;
}

/**
 * The `usage` event for one model call. Built in ONE place because two loops
 * emit it — the interactive Session and the headless build driver — and a field
 * added to one but not the other silently halves what the log analyzer sees.
 *
 * `tokensPerSecond`/`ms` ride only when a generation time is supplied. The build
 * driver times a whole turn, tool execution included, and publishing that as a
 * generation rate would understate tok/s by an order of magnitude — so it emits
 * counts alone rather than a wrong number.
 */
export function usageEvent(args: {
  task: string;
  usage: ITokenUsage;
  genMs?: number;
  thinking?: boolean;
}): ILoopEvent {
  const { task, usage, genMs, thinking } = args;
  const tps = generationRate(usage.completionTokens, genMs);
  const rate = tps === undefined ? "" : ` · ${String(tps)} tok/s`;

  return {
    kind: "usage",
    task,
    message: `tokens ${String(usage.promptTokens)} in / ${String(usage.completionTokens)} out${cacheSuffix(usage)}${rate}`,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedPromptTokens === undefined
      ? {}
      : { cachedPromptTokens: usage.cachedPromptTokens }),
    ...(tps === undefined ? {} : { tokensPerSecond: tps }),
    ...(genMs === undefined ? {} : { ms: Math.round(genMs) }),
    ...(thinking === undefined ? {} : { thinking }),
  };
}

/**
 * Completion tokens per second, or undefined when no generation time was
 * measured at all.
 *
 * An UNMEASURED call and a call measured at zero elapsed are different, and only
 * the first may drop the field: a caller that supplies a time always gets a
 * number, so a sub-millisecond call still reports `0 tok/s` rather than
 * silently losing its rate from the metrics.
 */
function generationRate(
  completionTokens: number,
  genMs: number | undefined
): number | undefined {
  if (genMs === undefined) {
    return undefined;
  }

  return genMs > 0 ? Math.round((completionTokens / genMs) * 1000) : 0;
}

/** ` · 4096 cached (80%)` when the server reported prefix-cache hits, and NOTHING
 *  when it reported none. An endpoint that doesn't publish the field must not
 *  render as a 0% hit rate: 0% is the harness having broken its own prompt
 *  prefix, which is a bug worth chasing, and the two must stay distinguishable
 *  at a glance in the run log. */
function cacheSuffix(usage: ITokenUsage): string {
  const cached = usage.cachedPromptTokens;

  if (cached === undefined) {
    return "";
  }

  // Clamped through the SAME helper the run-level metric uses. A backend
  // reporting more cached tokens than prompt tokens would otherwise print
  // "500%" here while the aggregate quietly capped at 1 — one bad server, two
  // different stories, and the log is where someone goes to check the other.
  const pct =
    usage.promptTokens > 0
      ? Math.round(clampRatio(cached / usage.promptTokens) * 100)
      : 0;

  return ` · ${String(cached)} cached (${String(pct)}%)`;
}
