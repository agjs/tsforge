export interface IExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  argv: readonly string[],
  opts: { cwd: string; env?: Record<string, string> }
) => Promise<IExecResult>;

/** Real Bun.spawn runner for generators + format + optional smoke. */
export const bunExec: Exec = async (argv, opts) => {
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;

  return { code, stdout, stderr };
};
