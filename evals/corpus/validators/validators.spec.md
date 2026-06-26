---
id: validators
title: Field validators (one predicate module per rule)
verify: bun test
mode: scratch
---

## Acceptance criteria

Each rule lives in its own module exporting a single predicate `(v: string) => boolean`. All six share the same shape — only the rule differs.

A1. `nonEmpty.ts` → `isNonEmpty`: true iff `v` has at least one non-whitespace character.
A2. `positive.ts` → `isPositive`: true iff `v` parses to a finite number greater than 0.
A3. `email.ts` → `isEmail`: true iff `v` looks like `local@domain.tld` (non-empty local, domain, and TLD; no spaces or stray `@`).
A4. `slug.ts` → `isSlug`: true iff `v` is lowercase alphanumeric words joined by single hyphens (e.g. `my-post-1`), no leading/trailing/double hyphens, no spaces or uppercase.
A5. `hexColor.ts` → `isHexColor`: true iff `v` is a 6-digit hex color, optional leading `#` (e.g. `#a1b2c3` or `a1b2c3`), case-insensitive.
A6. `uuid.ts` → `isUuid`: true iff `v` is a canonical 8-4-4-4-12 hex UUID.

## Tasks

1. [validators] Create the six predicate modules
   accept: bun test validators.test.ts
   files: nonEmpty.ts, positive.ts, email.ts, slug.ts, hexColor.ts, uuid.ts
   context: validators.test.ts
