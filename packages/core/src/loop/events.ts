/** A progress event emitted as the loop runs, for live observability. */
export interface ILoopEvent {
  kind:
    | "start"
    | "red"
    | "cycle"
    | "token"
    | "fix"
    | "edit"
    | "create"
    | "validated"
    | "done"
    | "stuck"
    | "run"
    | "tool"
    | "timing";
  task: string;
  message: string;
  cycle?: number;
  cycles?: number;
  /** For `timing` events: how long the turn took, in milliseconds. */
  ms?: number;
  errors?: number;
  passed?: boolean;
  file?: string;
  /** For `create` events: the new file's content (rendered as a code block). */
  content?: string;
  /** For `edit` events: the replaced / replacement snippets (rendered as a diff). */
  oldString?: string;
  newString?: string;
  /** For `run` events: the shell command and its result. */
  command?: string;
  exitCode?: number;
  output?: string;
}

export type Reporter = (event: ILoopEvent) => void;
