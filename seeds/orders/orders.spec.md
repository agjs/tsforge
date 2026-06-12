---
id: orders
title: Order pricing engine
verify: bun test order.test.ts
mode: scratch
---

## Acceptance criteria

A1. The data contract in `types.ts` is fixed (read-only): products, cart lines, a discriminated `Discount` union (`percent` | `fixed` | `bogo`), and the order summary shape. Implement the logic to it.
A2. `pricing.ts` computes per-line numbers in integer cents: a line subtotal, the discount it earns (percent rounded to the nearest cent; fixed clamped so it never exceeds the subtotal; bogo = every second unit free), and the net (subtotal − discount).
A3. `tax.ts` returns the sales-tax/VAT for a region (Oregon is tax-free) and rounds the tax to the nearest cent.
A4. `order.ts` rolls a cart into a summary: tax applies only to the discounted net of taxable lines, and the order total is subtotal − discount + tax.

## Tasks

1. [logic] implement the pricing, tax, and order-summary modules so the suite passes
     accept: bun test order.test.ts
     files: pricing.ts, tax.ts, order.ts
     context: types.ts, order.test.ts
     fix: bun eslint --fix pricing.ts tax.ts order.ts
