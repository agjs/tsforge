import { test, expect } from "bun:test";
import { fetchWithRetry } from "../src/inference/transport";

const URL = "http://localhost:9999/v1/chat/completions";
const HEADERS = { "content-type": "application/json" };
const BODY = "{}";

/** A fetch stub that throws `error` for the first `failTimes` calls, then returns
 *  a 200. Records how many times it was invoked. */
function flakyFetch(failTimes: number, error: Error) {
  let calls = 0;
  const fn = (async () => {
    calls += 1;

    if (calls <= failTimes) {
      throw error;
    }

    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  return {
    fetch: fn,
    get calls() {
      return calls;
    },
  };
}

test("retries a transient connection error, then succeeds within budget", async () => {
  const stub = flakyFetch(1, new Error("connection refused"));

  const res = await fetchWithRetry(stub.fetch, URL, HEADERS, BODY, 5000);

  expect(res.status).toBe(200);
  expect(stub.calls).toBe(2); // one failure + one success
});

test("gives up once the connect-retry budget is exhausted", async () => {
  const stub = flakyFetch(99, new Error("ECONNREFUSED"));

  // Tiny budget → the next backoff already exceeds it, so it throws after attempt 1.
  await expect(
    fetchWithRetry(stub.fetch, URL, HEADERS, BODY, 5000, undefined, 10)
  ).rejects.toThrow(/ECONNREFUSED/u);
  expect(stub.calls).toBe(1);
});

test("does NOT retry a non-transient error", async () => {
  const stub = flakyFetch(99, new Error("400 Bad Request"));

  await expect(
    fetchWithRetry(stub.fetch, URL, HEADERS, BODY, 5000, undefined, 60_000)
  ).rejects.toThrow(/Bad Request/u);
  expect(stub.calls).toBe(1); // thrown immediately, no retry
});

test("a generous budget rides out repeated connection failures (server restart)", async () => {
  // Fails 4× — past the old fixed 4-attempt window — then comes back. With a large
  // budget it must keep retrying and ultimately succeed.
  const stub = flakyFetch(4, new Error("Unable to connect"));

  const res = await fetchWithRetry(
    stub.fetch,
    URL,
    HEADERS,
    BODY,
    5000,
    undefined,
    60_000
  );

  expect(res.status).toBe(200);
  expect(stub.calls).toBe(5);
}, 30_000);

test("a caller abort is terminal — no retry", async () => {
  const stub = flakyFetch(99, new Error("connection reset"));
  const ac = new AbortController();

  ac.abort();

  await expect(
    fetchWithRetry(stub.fetch, URL, HEADERS, BODY, 5000, ac.signal, 60_000)
  ).rejects.toBeDefined();
  expect(stub.calls).toBe(0); // aborted before the first attempt
});
