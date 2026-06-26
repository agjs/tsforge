---
id: fixtures
title: Entity fixture factories (one module per entity)
verify: bun test
mode: scratch
---

## Acceptance criteria

A1. For each of the six entities — `user`, `order`, `product`, `invoice`, `payment`, `shipment` — a module `<entity>.ts` exports a factory named `make<Entity>` (e.g. `user.ts` → `makeUser`, `order.ts` → `makeOrder`). Each returns `IEntity`, imported from `./types` (`{ id: string; kind: string }`).

A2. The factory returns an object whose `kind` is the entity name (e.g. `"user"`) and whose `id` is a non-empty string. The six modules are identical in shape — only the name and the `kind` value differ.

## Tasks

1. [fixtures] Create the six entity fixture modules
   accept: bun test fixtures.test.ts
   files: user.ts, order.ts, product.ts, invoice.ts, payment.ts, shipment.ts
   context: fixtures.test.ts, types.ts
