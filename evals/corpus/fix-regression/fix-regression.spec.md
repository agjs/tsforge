---
id: fix-regression
title: Restore a regressed slugify
verify: bun test
mode: existing
---

## Acceptance criteria

A1. `slugify(input)` lowercases the input, replaces any run of non-alphanumeric
characters with a SINGLE hyphen, and trims leading/trailing hyphens. A recent
change broke the "run → single hyphen" collapse (it now emits repeated hyphens);
restore the correct behaviour.

## Tasks

1. [fix] Restore slugify so its test passes
   accept: bun test slug.test.ts
   files: slug.ts
   context: slug.test.ts
