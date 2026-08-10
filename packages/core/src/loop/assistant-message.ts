import type { IChatMessage, IModelResponse, IToolCall } from "../inference";

/**
 * History owns its tool-call args. Provider responses (and test `scripted()`
 * fixtures) must not share mutable argument objects with message history —
 * `pruneEphemeralToolResidue` rewrites aged create/edit args in place, which
 * otherwise poisons the next run that reuses the same scripted step
 * (`tool_rejected:create:history-meta` after a prior TDD red run).
 */
function cloneToolCalls(calls: readonly IToolCall[]): IToolCall[] {
  return calls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: { ...tc.arguments },
  }));
}

/** Build the assistant history message to record after a model call, carrying
 *  `reasoningContent` when the model produced it (DeepSeek's thinking mode requires it
 *  replayed on the next turn).
 *
 *  When a TTSR rule fired mid-stream the generation was ABORTED partway through — any
 *  `toolCalls` on the response are partial and never executed. Recording them would leave
 *  an assistant `tool_calls` message with no matching tool responses, which strict
 *  OpenAI-compatible APIs reject on the NEXT request ("An assistant message with
 *  'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.",
 *  e.g. DeepSeek's hosted API 400). A lenient local server tolerates it; a hosted one
 *  does not. So on a TTSR abort we drop the partial tool_calls and keep only the text
 *  (with a placeholder when it was empty, so the message is never both content-less and
 *  tool-less). The corrective guidance is appended separately as a user message by
 *  applyTtsrInterrupt. Shared by BOTH loops (Session.drive and runTask) so the two can't
 *  drift — a fix in one path but not the other left the bug live on the headless loop. */
export function assistantMessage(res: IModelResponse): IChatMessage {
  const reasoning =
    res.reasoning === undefined ? {} : { reasoningContent: res.reasoning };

  if (res.ttsrFired !== undefined) {
    return {
      role: "assistant",
      content:
        res.content.length > 0
          ? res.content
          : "(generation interrupted before completion)",
      ...reasoning,
    };
  }

  return {
    role: "assistant",
    content: res.content,
    toolCalls: cloneToolCalls(res.toolCalls),
    ...reasoning,
  };
}
