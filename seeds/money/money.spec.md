---
id: money
title: Money value object
verify: bun test money.test.ts
mode: scratch
---

## Acceptance criteria

A1. Money is stored as integer minor units (cents) so decimal arithmetic never drifts.
A2. Construction validates input (`fromCents` rejects fractional cents) and parsing accepts formatted strings — grouping, currency symbols, a leading minus, and accounting-style `(1,234.56)` parentheses for negatives.
A3. `add`/`subtract` reject mixing two different currencies.
A4. `times` rounds to the nearest cent.
A5. `allocate(weights)` splits an amount across integer weights so the parts sum EXACTLY to the total — leftover cents are handed out one at a time to the earliest buckets, and negative leftovers are taken back the same way. No cent is created or lost.
A6. `toString` formats with grouping, the currency symbol, and a leading sign (e.g. `$1,234.56`, `-$0.99`).

## Tasks

1. [logic] implement the Money value object so the test suite passes
     accept: bun test money.test.ts
     files: money.ts
     context: money.test.ts
     fix: bun eslint --fix money.ts
