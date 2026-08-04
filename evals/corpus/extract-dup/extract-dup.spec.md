---
id: extract-dup
title: De-duplicate a rounding helper across a codebase
verify: bun test
mode: existing
---

## Acceptance criteria

A1. `src/shared/money.ts` exports `roundHalfUp(cents: number, factor: number)`
implementing HALF-UP rounding away from zero: `roundHalfUp(-125, 1)` is `-13`
tenths-of-a-cent → i.e. ties round away from zero, not toward positive infinity.

A2. Every module that currently inlines that same half-up rounding imports it
from `src/shared/money.ts` instead. No module may keep its own copy.

A3. `src/reporting/forecast.ts` looks similar but is NOT the same function — it
rounds HALF-EVEN (banker's rounding). It must keep its own behaviour and must
NOT be rewired to the shared helper.

A4. All existing behaviour is preserved exactly; `bun test` passes.

## Tasks

1. [extract] Extract the shared rounding helper and rewire its call sites
   accept: bun test
   files: src/shared/money.ts, src/billing/invoice.ts, src/orders/total.ts, src/shipping/quote.ts, src/reporting/forecast.ts
   context: src/shared/structure.test.ts, src/billing/invoice.test.ts, src/orders/total.test.ts, src/shipping/quote.test.ts, src/reporting/forecast.test.ts, src/shared/money.test.ts
