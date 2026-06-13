---
id: slugify
title: URL slug helper
verify: bun test
mode: scratch
---

## Acceptance criteria

A1. `slugify(input)` lowercases the input, replaces any run of non-alphanumeric
characters with a single hyphen, and trims leading/trailing hyphens.
A2. Accented Latin characters are folded to ASCII (e.g. `é` → `e`) before slugging.

## Tasks

1. [slugify] Implement slugify
   accept: bun test slugify.test.ts
   files: slugify.ts
   context: slugify.test.ts
