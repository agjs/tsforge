---
id: debounce
title: Debounce a function
verify: bun test
mode: scratch
---

## Acceptance criteria

A1. `debounce(fn, ms)` returns a function that delays calling `fn` until `ms`
have elapsed since the LAST invocation; rapid successive calls collapse into one.
A2. The single delayed call receives the arguments from the MOST RECENT call.
A3. After the timer fires, a later call starts a fresh delay (a new burst calls
`fn` again).

## Tasks

1. [debounce] Implement debounce
   accept: bun test debounce.test.ts
   files: debounce.ts
   context: debounce.test.ts
