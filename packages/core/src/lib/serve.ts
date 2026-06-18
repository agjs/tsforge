/** Start a Bun server on an ephemeral localhost port (`port: 0`), retrying the
 *  bind with a short backoff. `port: 0` should always pick a free port, but Bun
 *  builds older than the 1.3.14 this repo pins intermittently throw EADDRINUSE on
 *  it under load (many tests binding at once); a few spaced retries make startup
 *  deterministic regardless of build. One place so the gate-runtime static server
 *  and the tests share the same robustness. */
export interface IEphemeralServeOptions {
  fetch: (req: Request) => Response | Promise<Response>;
}

export async function serveEphemeral(
  options: IEphemeralServeOptions,
  attempts = 8
): Promise<ReturnType<typeof Bun.serve>> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return Bun.serve({ port: 0, fetch: options.fetch });
    } catch (err) {
      lastErr = err;
      // Give the OS a moment to release whatever transiently collided before the
      // next attempt — a tight synchronous retry tends to re-hit the same race.
      await Bun.sleep(10 * (attempt + 1));
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("serveEphemeral: could not bind an ephemeral port");
}
