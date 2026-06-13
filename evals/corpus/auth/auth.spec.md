---
id: auth
title: Auth service with sessions and lockout
verify: bun test
mode: scratch
---

## Acceptance criteria

A1. `validatePassword(pw)` returns `{ ok: true }` or `{ ok: false; reasons: PasswordReason[] }`. Password must be >= 10 chars, contain upper, lower, digit, and symbol. Reasons are an exhaustive list of failures.

A2. `issueSession(userId, now, ttlMs)` issues a token with exact expiry = `now + ttlMs`. Token is deterministic (same inputs = same output). `validateSession(token, now)` returns true strictly before expiry (not at expiry). No `Date.now()` or randomness; time is injected via `now`.

A3. `signup(email, password, now)` creates account or returns password error. Rejects duplicate email.

A4. `login(email, password, now)` checks password, locks after 5 consecutive failed attempts for 15 minutes (measured via injected clock). Successful login resets fail counter. Lockout window boundary is exact: at 5th failure it locks; during window even correct password fails; after window it unlocks.

## Tasks

1. [auth] Implement the passwords, sessions, and accounts modules
   accept: bun test auth.test.ts
   files: passwords.ts, sessions.ts, accounts.ts
   context: auth.test.ts
