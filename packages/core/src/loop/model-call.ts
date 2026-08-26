/**
 * The pure per-call decisions inside Session.askModel, extracted so the two
 * behaviours that MUST not regress silently — plan mode's read-only tool
 * filter and the adaptive thinking mode — have direct unit tests.
 */
import { READ_ONLY_TOOL_NAMES, TOOL_NAME } from "../agent";
import type { ITokenUsage } from "../inference";
import { clampRatio } from "../lib/ratio";
import type { ILoopEvent } from "./loop.types";

/** Checklist tools — withheld until a session binds activePlanId. */
const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAME.taskList,
  TOOL_NAME.taskFocus,
  TOOL_NAME.taskComplete,
  TOOL_NAME.taskUncomplete,
  TOOL_NAME.taskAdd,
  TOOL_NAME.taskUpdate,
]);

/** Propose-plan tool — only useful in plan mode (approve binds the proposal). */
const PRESENT_PLAN_NAME = TOOL_NAME.presentPlan;

/** Greenfield product-plan tool — only useful during Session.setGreenfieldMode. */
const PRODUCT_PLAN_NAME = TOOL_NAME.productPlan;

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
  wiring: readonly IToolWiring[] = [],
  offerTaskTools = false,
  greenfieldMode = false
): (T | U)[] {
  const scoped = tools.filter((t) => {
    if (!offerTaskTools && TASK_TOOL_NAMES.has(t.function.name)) {
      return false;
    }

    // present_plan only while planning — after approve it's noise.
    if (!planMode && t.function.name === PRESENT_PLAN_NAME) {
      return false;
    }

    // propose_product_plan only during greenfield discovery — a distinct,
    // transient state from planMode (pre-approval discovery for a NEW
    // product, not read-only exploration of an existing one).
    if (!greenfieldMode && t.function.name === PRODUCT_PLAN_NAME) {
      return false;
    }

    return true;
  });
  // Greenfield planning gets the SAME read-only restriction plan mode does —
  // it is pre-approval discovery for a NEW product, same "cannot mutate yet"
  // contract, just a distinct transient flag from planMode.
  const base =
    planMode || greenfieldMode
      ? scoped.filter(
          (t) =>
            READ_ONLY_TOOL_NAMES.has(t.function.name) ||
            t.function.name === TOOL_NAME.run
        )
      : [...scoped];

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
  /** WALL time for the whole call, prefill included. `genMs` starts at the first
   *  token, so on a prefix-caching server it can hide almost the entire cost: a
   *  logged 168s call reported 6.7s. Kept separate rather than folded into `ms`
   *  so tok/s stays a GENERATION rate. */
  callMs?: number;
  thinking?: boolean;
}): ILoopEvent {
  const { task, usage, genMs, callMs, thinking } = args;
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
    ...(callMs === undefined ? {} : { callMs: Math.round(callMs) }),
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
  //
  // A zero-token prompt yields no share at all rather than "0%": 0% is the
  // reserved "the prefix went cold" reading, and a server that reported cached
  // tokens against no prompt has told us something incoherent, not something
  // cold.
  const share =
    usage.promptTokens > 0 ? clampRatio(cached / usage.promptTokens) : null;

  if (share === null) {
    return ` · ${String(cached)} cached (share unknown)`;
  }

  return ` · ${String(cached)} cached (${String(Math.round(share * 100))}%)`;
}
