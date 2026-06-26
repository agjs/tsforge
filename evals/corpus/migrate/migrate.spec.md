---
id: migrate
title: Migrate every service from oldApi to newApi (per-file tier)
verify: bun test
mode: existing
---

## Acceptance criteria

A1. Every `svc<N>.ts` currently calls the deprecated `oldApi(payload)`. Migrate each to `newApi(payload, tier)`, where `tier` is the string from that file's `// tier: <name>` header comment (e.g. `svc1.ts` is `// tier: gold` → `newApi("ping", "gold")`). The tier differs per file, so each edit is distinct — you must read each file to know its tier.

A2. Import `newApi` from `./api` and remove the now-unused `oldApi` import (the gate forbids unused imports). Do not change `api.ts` or the payload string.

## Tasks

1. [migrate] Migrate all eight services to newApi with their per-file tier
   accept: bun test migrate.test.ts
   files: svc1.ts, svc2.ts, svc3.ts, svc4.ts, svc5.ts, svc6.ts, svc7.ts, svc8.ts
   context: migrate.test.ts, api.ts
