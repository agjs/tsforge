import type { IModelResponse, IProvider } from "../src/inference";

/** A `typeof fetch` that answers every call with a freshly built response.
 *
 *  Composed with `Object.assign` rather than cast: Bun's `typeof fetch` also
 *  carries `preconnect`, so a bare async function does not satisfy it — and the
 *  house rule forbids the `as unknown as typeof fetch` shortcut. A factory, not
 *  a value, because a `Response` body can only be consumed once. */
export function fetchReturning(make: () => Response): typeof fetch {
  const impl = async (): Promise<Response> => make();

  return Object.assign(impl, { preconnect: globalThis.fetch.preconnect });
}

/** A provider that replays a scripted sequence of responses, one per turn
 *  (repeating the last once exhausted). For driving the agentic loop in tests. */
export function scripted(steps: IModelResponse[]): IProvider {
  let i = 0;

  return {
    async complete() {
      const step = steps[Math.min(i, steps.length - 1)] ?? {
        content: "",
        toolCalls: [],
      };

      i += 1;

      return step;
    },
  };
}

export function runStep(command: string): IModelResponse {
  return { content: "", toolCalls: [{ name: "run", arguments: { command } }] };
}

export function createStep(file: string, content: string): IModelResponse {
  return {
    content: "",
    toolCalls: [{ name: "create", arguments: { file, content } }],
  };
}

export function editStep(
  file: string,
  oldString: string,
  newString: string
): IModelResponse {
  return {
    content: "",
    toolCalls: [{ name: "edit", arguments: { file, oldString, newString } }],
  };
}

/** No tool calls — signals the model believes it is done (triggers the gate). */
export const STOP: IModelResponse = { content: "done", toolCalls: [] };
