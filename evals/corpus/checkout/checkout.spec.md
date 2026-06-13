---
id: checkout
title: Checkout and pricing engine
verify: bun test
mode: scratch
---

## Acceptance criteria

A1. Coupon types are a DISCRIMINATED UNION with an EXHAUSTIVE switch on `kind`:

- `{ kind: "percent"; off: number }` — percentage discount (0–100)
- `{ kind: "fixed"; cents: number }` — fixed amount discount in cents
- `{ kind: "bogo"; sku: string }` — buy-one-get-one free for the specified SKU
  A non-exhaustive switch must fail the gate.

A2. Money is INTEGER CENTS everywhere (no floats allowed); rounding is half-up to nearest cent.

A3. Tax is applied AFTER discounts. Discount total is clamped so the final total never goes negative.

A4. Cart line items track sku, unit price in cents, and quantity. Inventory limits can clamp or reject oversized qty.

A5. `checkout(cart, coupons, taxRatePpm)` returns `{ subtotalCents, discountCents, taxCents, totalCents }`.

A6. Multiple coupons stack in a defined order (e.g., percent → fixed → bogo).

## Tasks

1. [checkout] Implement the coupons, pricing, and cart modules
   accept: bun test checkout.test.ts
   files: coupons.ts, pricing.ts, cart.ts
   context: checkout.test.ts
