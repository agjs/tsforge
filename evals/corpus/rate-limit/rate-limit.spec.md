---
id: rate-limit
title: In-memory rate limiter
verify: bun test
mode: scratch
---

## Acceptance criteria

A1. `createRateLimiter(limit, windowMs, now)` returns `{ allow(key) }`. `allow`
returns `true` for the first `limit` calls per key within any `windowMs` window,
and `false` once that limit is exceeded.
A2. Capacity frees as hits age out of the sliding window, measured with the
injected `now()` clock (milliseconds) — never wall-clock time.
A3. Each `key` is tracked independently.

## Tasks

1. [rate-limit] Implement createRateLimiter
   accept: bun test rate-limit.test.ts
   files: rate-limit.ts
   context: rate-limit.test.ts
