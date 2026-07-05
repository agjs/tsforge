/**
 * The pure per-call decisions inside Session.askModel, extracted so the two
 * behaviours that MUST not regress silently — plan mode's read-only tool
 * filter and the adaptive thinking mode — have direct unit tests.
 */
import { READ_ONLY_TOOL_NAMES, TOOL_NAME } from "../agent";

/** The minimal shape shared by advertised tools and MCP tool schemas. */
interface INamedTool {
  readonly function: { readonly name: string };
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
  mcpSchemas: readonly U[]
): (T | U)[] {
  const base = planMode
    ? tools.filter(
        (t) =>
          READ_ONLY_TOOL_NAMES.has(t.function.name) ||
          t.function.name === TOOL_NAME.run
      )
    : [...tools];

  return mcpSchemas.length > 0 ? [...base, ...mcpSchemas] : base;
}
