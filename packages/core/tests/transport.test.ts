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

// ── I4: cause-chain classification + HTTP retry ─────────────────────────────

test("Node/undici-shaped 'fetch failed' with buried ECONNREFUSED retries", async () => {
  // Bun puts the story in err.message; Node throws TypeError: fetch failed
  // with the real code in err.cause (inside an AggregateError). The old
  // message-only regex made ride-out-a-restart a no-op off Bun.
  const inner = Object.assign(
    new Error("connect ECONNREFUSED 127.0.0.1:8888"),
    {
      code: "ECONNREFUSED",
    }
  );
  const undiciShaped = new TypeError("fetch failed");

  Object.defineProperty(undiciShaped, "cause", {
    value: new AggregateError([inner], "All attempts failed"),
  });

  const stub = flakyFetch(2, undiciShaped);
  const res = await fetchWithRetry(stub.fetch, URL, HEADERS, BODY, 5000);

  expect(res.status).toBe(200);
  expect(stub.calls).toBe(3);
});

/** A fetch stub returning `statuses` in order, then 200. */
function statusFetch(statuses: number[], headers: Record<string, string> = {}) {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    const status = statuses[calls - 1];

    if (status !== undefined) {
      return new Response("busy", { status, headers });
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

test("429 with integer Retry-After retries within the budget and succeeds", async () => {
  const stub = statusFetch([429], { "retry-after": "0" });
  const res = await fetchWithRetry(
    stub.fetch,
    URL,
    HEADERS,
    BODY,
    5000,
    undefined,
    10_000
  );

  expect(res.status).toBe(200);
  expect(stub.calls).toBe(2);
});

test("503 retries with backoff; a permanent 400 does NOT retry", async () => {
  const retried = statusFetch([503]);
  const ok = await fetchWithRetry(
    retried.fetch,
    URL,
    HEADERS,
    BODY,
    5000,
    undefined,
    10_000
  );

  expect(ok.status).toBe(200);
  expect(retried.calls).toBe(2);

  const permanent = statusFetch([400, 400, 400]);
  const rejected = await fetchWithRetry(
    permanent.fetch,
    URL,
    HEADERS,
    BODY,
    5000,
    undefined,
    10_000
  );

  expect(rejected.status).toBe(400);
  expect(permanent.calls).toBe(1);
});

test("at budget exhaustion the retryable response is RETURNED, not thrown (caller sees the status)", async () => {
  const stub = statusFetch([429, 429, 429, 429, 429, 429, 429, 429]);
  const res = await fetchWithRetry(
    stub.fetch,
    URL,
    HEADERS,
    BODY,
    5000,
    undefined,
    // Tiny budget: first 429 comes back immediately with wait >= budget.
    1
  );

  expect(res.status).toBe(429);
});
