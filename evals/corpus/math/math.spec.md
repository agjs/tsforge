---
id: math
title: Money math helpers
verify: bun test
mode: scratch
---

## Acceptance criteria

A1. `add(a, b)` returns the exact sum of two integer cent amounts.
A2. `mul(amount, qty)` multiplies a cent amount by an integer quantity, rounding
half-up to the nearest cent.

## Tasks

1. [add] Implement add
   accept: bun test add.test.ts
   files: add.ts
   context: add.test.ts

2. [mul] Implement mul with half-up rounding
   accept: bun test mul.test.ts
   files: mul.ts
   context: mul.test.ts
