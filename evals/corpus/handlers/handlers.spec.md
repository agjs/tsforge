---
id: handlers
title: Route handlers (one module per route)
verify: bun test
mode: scratch
---

## Acceptance criteria

Each route is its own module exporting `handle<Name>(): { status: number; body: string }`. All seven share the same shape — only the status and body differ.

A1. `health.ts` → `handleHealth` → `{ status: 200, body: "ok" }`
A2. `version.ts` → `handleVersion` → `{ status: 200, body: "v1" }`
A3. `ping.ts` → `handlePing` → `{ status: 200, body: "pong" }`
A4. `teapot.ts` → `handleTeapot` → `{ status: 418, body: "teapot" }`
A5. `notFound.ts` → `handleNotFound` → `{ status: 404, body: "not found" }`
A6. `gone.ts` → `handleGone` → `{ status: 410, body: "gone" }`
A7. `created.ts` → `handleCreated` → `{ status: 201, body: "created" }`

## Tasks

1. [handlers] Create the seven route handler modules
   accept: bun test handlers.test.ts
   files: health.ts, version.ts, ping.ts, teapot.ts, notFound.ts, gone.ts, created.ts
   context: handlers.test.ts
