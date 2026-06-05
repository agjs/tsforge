import type { ITask } from "../spec/types";
import type { ErrorSet } from "../validate/errors";
import type { Reporter } from "../loop/events";

export interface IAgentContext {
  /** Working directory the agent may edit within. */
  cwd: string;
  /** The chunk to implement. */
  task: ITask;
  /** Standing failures from the last gate run (empty on the first attempt). */
  errors: ErrorSet;
  /** 1-based repair cycle. */
  cycle: number;
  /** Optional progress sink (e.g. to report applied edits). */
  report?: Reporter;
}

/**
 * The seam where the model plugs in. The walking skeleton uses a canned stub;
 * later this is backed by the inference adapter (Qwen3.6 via vLLM/Ollama).
 */
export interface IAgent {
  implement(ctx: IAgentContext): Promise<void>;
}
