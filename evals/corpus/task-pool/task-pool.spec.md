---
id: task-pool
title: Bounded-concurrency async task pool
verify: bun test
mode: scratch
---

## Acceptance criteria

A1. `pool(tasks, limit)` runs at most `limit` tasks concurrently and resolves to
results in the ORDER OF THE INPUT, regardless of completion order. `tasks` is a
`ReadonlyArray<(signal: AbortSignal) => Promise<T>>`; `limit` is a positive
integer. A limit larger than the task count is allowed.

A2. Concurrency is never exceeded at any instant, and the pool starts the next
task as soon as a slot frees — it does not wait for a whole batch to finish.

A3. If a task rejects, the pool settles ALL tasks first, then rejects with an
`AggregateError` whose `errors` holds every rejection in input order. Results of
successful tasks are discarded. No unhandled rejection may escape.

A4. On the first rejection the pool aborts the signal passed to every task
(already-running and not-yet-started), so cooperative tasks can stop early. A
task that has not started when the pool aborts is never invoked.

A5. `pool([], n)` resolves to `[]`. A non-positive or non-integer `limit`
throws a `RangeError` synchronously, before any task runs.

## Tasks

1. [pool] Implement the bounded-concurrency pool
   accept: bun test pool.test.ts
   files: pool.ts
   context: pool.test.ts
