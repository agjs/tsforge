import { TOOL_NAME } from "../../agent";
import { str, reject, type IToolContext } from "./tool-context";

/** Monotonic per-process counter → a unique `parentTaskId` per spawn, so the
 *  child's `agentId` (`${parentTaskId}:${spec.id}`) is unique even when the
 *  orchestrator spawns two of the same specialist in one turn. */
let spawnSeq = 0;

/**
 * The `spawn_agent` tool: the orchestrator delegates one focused, read-only
 * investigation to a specialist subagent and gets its findings back as the tool
 * result. The heavy lifting (spec resolution, fresh provider, the read-only
 * AgentRunner, lifecycle events, the concurrency limiter) lives in the CLI-wired
 * `ctx.spawnAgent` callback — this handler only validates args and forwards.
 * Absent callback ⇒ delegation isn't available here (headless one-shot).
 */
export async function doSpawnAgent(
  args: Record<string, unknown>,
  ctx: IToolContext
): Promise<string> {
  const spawn = ctx.spawnAgent;

  if (spawn === undefined) {
    return reject(
      ctx,
      TOOL_NAME.spawnAgent,
      "delegation is not available in this context"
    );
  }

  const subagentType = str(args, "subagent_type").trim();
  const prompt = str(args, "prompt").trim();
  const description = str(args, "description").trim();

  if (subagentType === "" || prompt === "") {
    return reject(
      ctx,
      TOOL_NAME.spawnAgent,
      "`subagent_type` and `prompt` are required"
    );
  }

  spawnSeq += 1;

  return spawn(
    {
      subagentType,
      description: description === "" ? subagentType : description,
      prompt,
      parentTaskId: `${ctx.task}#${String(spawnSeq)}`,
    },
    { signal: ctx.signal, report: ctx.report }
  );
}
