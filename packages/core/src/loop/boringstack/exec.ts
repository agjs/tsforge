export interface IExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  argv: readonly string[],
  opts: { cwd: string; env?: Record<string, string> }
) => Promise<IExecResult>;
