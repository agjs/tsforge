/** Drain a spawned process's piped stdout + stderr to strings (the one place
 *  this Bun pattern lives, instead of `new Response(proc.stdout).text()`
 *  copy-pasted across every command runner). Pass `proc.stdout, proc.stderr`
 *  from a process spawned with `stdout: "pipe", stderr: "pipe"`. */
export async function readProcessOutput(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>
): Promise<{ stdout: string; stderr: string }> {
  const [out, err] = await Promise.all([
    new Response(stdout).text(),
    new Response(stderr).text(),
  ]);

  return { stdout: out, stderr: err };
}
