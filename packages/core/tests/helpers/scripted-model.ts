import type {
  IChatMessage,
  IModelResponse,
  IProvider,
  IToolCall,
} from "../../src/inference";

/**
 * A deterministic stand-in for the model seam (`IProvider`). Drives the real
 * agent loop with a scripted sequence of turns so a full session — tool calls,
 * gate, repair loop, final verdict — is replayable in a test without a live LLM.
 *
 * Each `complete()` consumes the next turn. A turn is either a fixed
 * `{content, toolCalls}` or a function of the conversation so far (so a turn can
 * REACT to gate feedback — e.g. "if the last message mentions the error, fix
 * it"). When the script is exhausted the model yields (no content, no tool
 * calls), which the loop reads as "the model is done".
 */
export interface IScriptedTurn {
  content?: string;
  toolCalls?: IToolCall[];
}

export type ScriptedTurn =
  | IScriptedTurn
  | ((messages: readonly IChatMessage[]) => IScriptedTurn);

export interface IScriptedModel extends IProvider {
  /** How many times the loop has called the model. */
  readonly calls: number;
}

/** Build one tool call for a scripted turn. */
export function call(name: string, args: Record<string, unknown>): IToolCall {
  return { name, arguments: args };
}

export function scriptedModel(turns: readonly ScriptedTurn[]): IScriptedModel {
  let idx = 0;

  return {
    get calls(): number {
      return idx;
    },

    complete(messages: readonly IChatMessage[]): Promise<IModelResponse> {
      // One call past the script returns the empty yield (the loop's natural
      // stop). Any call beyond that means the loop failed to terminate — throw
      // immediately so the test fails fast instead of hanging or hitting the
      // runaway-turn backstop.
      if (idx > turns.length) {
        throw new Error(
          `Scripted model called ${idx + 1} times, but the script has only ${turns.length} turns (loop did not terminate).`
        );
      }

      const turn = turns[idx];

      idx += 1;

      const resolved: IScriptedTurn =
        typeof turn === "function" ? turn(messages) : (turn ?? {});

      return Promise.resolve({
        content: resolved.content ?? "",
        toolCalls: resolved.toolCalls ?? [],
      });
    },
  };
}
