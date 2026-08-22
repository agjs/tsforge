import type { IRuleDoc } from "./rule-docs";

/**
 * Worked examples for the tsforge rule packs.
 *
 * A rule doc is the ONLY thing the model receives when the gate rejects its
 * code. Without a worked example it gets the rule's description — roughly what
 * the linter already printed — and has to guess the sanctioned shape. Worse, a
 * doc describing a mechanism the rule does not have sends it hunting: one
 * claimed fetch URLs could "pass through an allowlisted URL builder", and an
 * agent read tsforge's own rule source from inside an unrelated project looking
 * for an allowlist that was never built.
 *
 * Every entry here is EXECUTABLE and proven by `tests/rule-docs-examples.test.ts`:
 * `bad` must actually trip its rule, `good` must actually satisfy it, and both
 * must parse as standalone TypeScript the model can copy. A doc cannot drift
 * from its rule without that test failing.
 */
export const PACK_RULE_DOCS: Record<string, IRuleDoc> = {
  "tsforge/auth-cookie-must-be-httponly": {
    what: "Auth-cookie writes must set `httpOnly: true` (or spread a trusted cookie-config helper). JS-readable session cookies leak via XSS.",
    bad: '\n      setCookie("session", token, { secure: true });\n    ',
    good: '\n      setCookie("session", token, { httpOnly: true, secure: true });\n    ',
  },
  "tsforge/auth-cookie-must-be-secure-in-prod": {
    what: "Auth-cookie writes must set `secure:` to `true` or an env-derived expression (anything non-literal). Cookies leak over HTTP without it.",
    bad: '\n      setCookie("session", token, { httpOnly: true });\n    ',
    good: '\n      setCookie("session", token, { httpOnly: true, secure: true });\n    ',
  },
  "tsforge/await-dynamic-request-apis": {
    what: "Require awaiting Next.js dynamic request APIs (cookies, headers, draftMode) in app-router Server Components.",
    bad: 'import { cookies } from "next/headers";\nexport default async function Page() {\n  const jar = cookies();\n  return null;\n}',
    good: 'import { cookies } from "next/headers";\nexport default async function Page() {\n  const jar = await cookies();\n  return null;\n}',
    exampleFile: "app/page.tsx",
  },
  "tsforge/bcrypt-rounds-min": {
    what: "A low bcrypt cost factor makes stolen hashes cheap to crack. Pass at least the configured minimum (default 10) as the rounds argument.",
    bad: '\n      import bcrypt from "bcrypt";\n      bcrypt.hash(password, 8);\n    ',
    good: '\n      import bcrypt from "bcrypt";\n      bcrypt.hash(password, 10);\n    ',
  },
  "tsforge/catch-must-handle": {
    what: "Catch blocks must log, rethrow, or propagate errors \u2014 not silently return empty defaults on failure.",
    bad: "try { doWork(); } catch (e) { return null; }",
    good: "try { doWork(); } catch (e) { console.error(e); return null; }",
    exampleFile: "src/worker.ts",
  },
  "tsforge/caught-error-log-requires-cause": {
    what: "Log the caught error as `cause` \u2014 without it you lose the stack and the original failure.",
    bad: 'try {\n  await send();\n} catch (err) {\n  logger.error({ event: "send.failed", err });\n}',
    good: 'try {\n  await send();\n} catch (err) {\n  logger.error({ event: "send.failed", cause: err });\n}',
  },
  "tsforge/client-hooks-require-use-client": {
    what: "Require the 'use client' directive in app-router page/layout/template files that call client-only hooks. Server Components cannot use state/effect/navigation hooks \u2014 doing so crashes at runtime.",
    bad: 'import { useState } from "react";\nexport default function Page() { const [n] = useState(0); return null; }',
    good: '"use client";\nimport { useState } from "react";\nexport default function Page() { const [n] = useState(0); return null; }',
    exampleFile: "app/dashboard/page.ts",
    fixIsDirective: true,
  },
  "tsforge/component-file-purity": {
    what: "A component .tsx holds ONLY imports + the component. Inline types, constants, and helpers fail the gate — move types to <feature>.types.ts, constants to <feature>.constants.ts, pure helpers to src/lib/, then import them back. Use `as const` for label maps; for RHF defaultValues with mutable arrays, type as the form input (CreateXInput / z.infer<typeof schema>), not bare `as const`.",
    bad: '\n      const STATUS_LABEL = { draft: "Draft" };\n      type Status = keyof typeof STATUS_LABEL;\n      export function ItemsTable() { return <div>{STATUS_LABEL.draft}</div>; }\n    ',
    good: '\n      import { Table } from "@/components/ui/table";\n      import { itemColumns } from "../dashboard.constants";\n      import type { IItem } from "../dashboard.types";\n\n      export function ItemsTable({ items }: { items: readonly IItem[] }) {\n        return <Table columns={itemColumns} data={items} rowKey={(row) => row.id} />;\n      }\n    ',
    exampleFile: "src/views/Dashboard/components/ItemsTable.tsx",
  },
  "tsforge/consistent-status-via-set": {
    what: "Inside Elysia route handlers, set HTTP status via `set.status = N`, not by returning a `new Response(body, { status: N })`.",
    bad: 'const app = new Elysia();\n\napp.get("/users", () => {\n  return new Response("created", { status: 201 });\n});',
    good: 'const app = new Elysia();\n\napp.get("/users", ({ set }) => {\n  set.status = 201;\n\n  return "created";\n});',
  },
  "tsforge/dangerous-html-requires-sanitize": {
    what: "dangerouslySetInnerHTML requires a sanitization library (DOMPurify or equivalent) imported in the same file.",
    bad: "export function Page({ html }: { html: string }) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />;\n}",
    good: 'import DOMPurify from "isomorphic-dompurify";\nexport function Page({ html }: { html: string }) {\n  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;\n}',
    exampleFile: "src/Page.tsx",
  },
  "tsforge/error-boundary-require-use-client": {
    what: "Require 'use client' in app-router error.tsx and global-error.tsx \u2014 Next.js error boundaries must be Client Components.",
    bad: "export default function Error({ error }: { error: Error }) {\n  return <div>{error.message}</div>;\n}",
    good: '"use client";\nexport default function Error({ error }: { error: Error }) {\n  return <div>{error.message}</div>;\n}',
    exampleFile: "app/dashboard/error.tsx",
    fixIsDirective: true,
  },
  "tsforge/exported-functions-require-return-type": {
    what: "An exported function is an API. Annotate its return type so a body change cannot silently change the contract.",
    bad: "export function total(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0);\n}",
    good: "export function total(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}",
  },
  "tsforge/fake-timers-must-be-restored": {
    what: "Fake timers leak into every later test in the process unless restored.",
    bad: 'it("debounces", () => {\n  vi.useFakeTimers();\n  vi.advanceTimersByTime(1000);\n\n  expect(fn).toHaveBeenCalledTimes(1);\n});',
    good: 'it("debounces", () => {\n  vi.useFakeTimers();\n\n  try {\n    vi.advanceTimersByTime(1000);\n\n    expect(fn).toHaveBeenCalledTimes(1);\n  } finally {\n    vi.useRealTimers();\n  }\n});',
    exampleFile: "src/debounce.test.ts",
  },
  "tsforge/id-param-requires-object-authz": {
    what: "A handler taking an id must prove the CALLER owns that object \u2014 authenticating is not authorizing.",
    bad: "",
    good: "",
    exampleFile: "app/api/posts/[id]/route.ts",
    procedure:
      "Authenticating is not authorizing. After you know WHO the caller is, scope the lookup to them: put the ownership column in the same `where` (`where: { id: params.id, ownerId: session.userId }`) rather than fetching by id and checking afterwards \u2014 a post-hoc check still leaks existence through timing and error shape.",
  },
  "tsforge/job-name-must-be-constant": {
    what: "Disallow string-literal job names in `<queue>.add(name, ...)` calls \u2014 use a constant identifier so all consumers share one source of truth.",
    bad: '\n      import { Queue } from "bullmq";\n      const emailQueue = new Queue("email");\n      emailQueue.add("send-email", { to: "user@example.com" });\n    ',
    good: '\n      import { Queue } from "bullmq";\n      const JOB_NAMES = { SendEmail: "send-email" } as const;\n      const emailQueue = new Queue("email");\n      emailQueue.add(JOB_NAMES.SendEmail, { to: "user@example.com" });\n    ',
  },
  "tsforge/job-options-must-set-attempts": {
    what: "Every `<queue>.add(...)` must configure `attempts` (per-call or via `defaultJobOptions`); when `attempts > 1`, also require `backoff`.",
    bad: '\n      import { Queue } from "bullmq";\n      const emailQueue = new Queue("email");\n      emailQueue.add("send", {}, {});\n    ',
    good: '\n      import { Queue } from "bullmq";\n      const emailQueue = new Queue("email");\n      emailQueue.add("send", {}, { attempts: 3, backoff: { type: "exponential", delay: 1000 } });\n    ',
  },
  "tsforge/logger-not-console": {
    what: "`console` in a service loses structure, level and correlation. Use the injected logger.",
    bad: 'export function chargeCard(id: string): void {\n  console.log("charging", id);\n}',
    good: 'export function chargeCard(id: string): void {\n  logger.info({ event: "card.charge.start", cardId: id });\n}',
    exampleFile: "src/billing/billing.service.ts",
  },
  "tsforge/mask-pii-fields": {
    what: "PII in a log payload leaks quietly and is hard to purge afterwards. Mask or drop the field before logging \u2014 log an id or a hash instead of the value.",
    bad: '\n      logger.info({ event: "user_created", email: user.email });\n    ',
    good: '\n      logger.info({ event: "user_created", email: maskEmailForLogging(user.email) });\n    ',
  },
  "tsforge/mutating-route-requires-authz": {
    what: "Every mutating route (POST/PUT/PATCH/DELETE) must authorize before it writes.",
    bad: "export async function POST(req: Request) {\n  const body = await req.json();\n\n  await db.post.create({ data: body });\n\n  return new Response(null, { status: 201 });\n}",
    good: "export async function POST(req: Request) {\n  const session = await requireUser();\n  const body = await req.json();\n\n  await db.post.create({ data: { ...body, ownerId: session.userId } });\n\n  return new Response(null, { status: 201 });\n}",
    exampleFile: "app/api/posts/route.ts",
  },
  "tsforge/no-api-key-in-client": {
    what: "Disallow constructing an AI provider client in a client component \u2014 it leaks the API key into the browser bundle. Call the model from a server route/action.",
    bad: "",
    good: "",
    procedure:
      'MOVE the client construction into a server module \u2014 a route handler, a server action, or a file never imported from a "use client" tree \u2014 and call it from the component. There is no same-file fix worth showing: deleting the directive silences the rule while the key still ships in whatever bundle imports that module. What must change is WHERE the key is read, not how the file is labelled.',
  },
  "tsforge/no-auth-token-in-storage": {
    what: "Disallow storing or reading auth tokens from localStorage/sessionStorage \u2014 use httpOnly cookies instead.",
    bad: 'export function saveSession(token: string): void {\n  localStorage.setItem("auth_token", token);\n}',
    good: 'export async function saveSession(token: string): Promise<void> {\n  // Exchanged immediately for an httpOnly cookie and never persisted:\n  // it lives only as an argument, so no XSS-readable copy survives.\n  await fetch("/api/session", {\n    method: "POST",\n    credentials: "include",\n    headers: { authorization: `Bearer ${token}` },\n  });\n}',
    exampleFile: "src/auth.ts",
  },
  "tsforge/no-bare-date-now": {
    what: "Time and randomness must come from an injectable util, or snapshots, replays and time-travel tests cannot be deterministic. Bare Date/Math.random belong only in a clock file named time.ts / clock.ts / now.ts (auto-allowlisted).",
    bad: "export function stamp() {\n  return { at: Date.now(), id: Math.random() };\n}",
    good: 'import { now, randomId } from "./time";\n\nexport function stamp() {\n  return { at: now(), id: randomId() };\n}',
    // Globs mirror the rule's own allowlist (rule-packs/code-flow/no-bare-date-now).
    exemplar: {
      symbols: ["now", "getNow", "clock", "randomId"],
      fileGlobs: ["**/time.ts", "**/clock.ts", "**/now.ts"],
    },
  },
  "tsforge/no-blocking-concurrency-zero": {
    what: "A non-positive `concurrency` stops the worker processing anything. Set it to a positive integer sized to the job's cost \u2014 start at 1 and raise it.",
    bad: '\n      import { Worker } from "bullmq";\n      new Worker("queue", async () => {}, { concurrency: 0 });\n    ',
    good: '\n      import { Worker } from "bullmq";\n      new Worker("queue", async () => {}, { concurrency: 5 });\n    ',
  },
  "tsforge/no-child-process-exec": {
    what: "Disallow child_process.exec/execSync \u2014 they run commands in a shell. Use execFile or spawn without shell instead.",
    bad: 'import * as child_process from "child_process";\nchild_process.exec("rm -rf /");',
    good: 'import { execFile } from "child_process";\nexecFile("ls", ["-la"], () => {});',
    exampleFile: "src/runner.ts",
  },
  "tsforge/no-conditional-expect": {
    what: "An assertion inside a branch can be skipped entirely and the test still passes. Assert unconditionally.",
    bad: 'it("rejects invalid input", () => {\n  const result = parse("x");\n\n  if (result.ok === false) {\n    expect(result.error).toBe("invalid");\n  }\n});',
    good: 'it("rejects invalid input", () => {\n  const result = parse("x");\n\n  expect(result.ok).toBe(false);\n  expect(result.error).toBe("invalid");\n});',
    exampleFile: "src/parse.test.ts",
  },
  "tsforge/no-vacuous-expect": {
    what: "Vacuous expects prove almost nothing — typeof checks, boolean tautologies, or a sole toBeDefined/toBeTruthy. Assert a domain result that fails when the product regresses.",
    bad: 'it("exports createShift", () => {\n  expect(typeof createShift).toBe("function");\n});',
    good: 'it("rejects an inverted time range", () => {\n  expect(() => createShift({ start: "18:00", end: "09:00" })).toThrow(/end/);\n});',
    exampleFile: "src/shifts.test.ts",
  },
  "tsforge/no-decorate-state-collision": {
    what: "Two `.decorate()`/`.state()`/`.derive()`/`.resolve()` calls sharing a key silently overwrite each other. Give each one a distinct key, or namespace them per plugin.",
    bad: '\n      const app = new Elysia()\n        .decorate("db", createDb())\n        .decorate("db", createCache());\n    ',
    good: '\n      const app = new Elysia()\n        .decorate("db", createDb())\n        .decorate("cache", createCache());\n    ',
  },
  "tsforge/no-derived-state-in-effect": {
    what: "Decide: is this I/O or derived data? OK — useEffect that fetches/subscribes then setState from the async result (TDD data-loading). NOT OK — syncing props into state or computing a value from other state/props inside an effect (double-render / tear). For derived values use render or useMemo; for async I/O keep the effect.",
    bad: 'import { useEffect, useState } from "react";\n\nexport function Total({ items }: { items: number[] }) {\n  const [total, setTotal] = useState(0);\n\n  useEffect(() => {\n    setTotal(items.reduce((a, b) => a + b, 0));\n  }, [items]);\n\n  return <p>{total}</p>;\n}',
    good: 'import { useMemo } from "react";\n\nexport function Total({ items }: { items: number[] }) {\n  const total = useMemo(\n    () => items.reduce((a, b) => a + b, 0),\n    [items],\n  );\n\n  return <p>{total}</p>;\n}',
    exampleFile: "src/Total.tsx",
  },
  "tsforge/no-direct-process-env": {
    what: "Read env through one validated config module, so a missing variable fails at boot, not mid-request.",
    bad: "export const client = createClient(process.env.API_URL);",
    good: 'import { env } from "./config/env";\n\nexport const client = createClient(env.API_URL);',
  },
  "tsforge/no-dynamic-regexp": {
    what: "Disallow new RegExp(non-literal) \u2014 dynamic patterns enable ReDoS. Use string-literal regexes or a safe engine like re2.",
    bad: "const pattern = userInput;\nconst re = new RegExp(pattern);",
    good: 'const re = new RegExp("^foo$");',
    exampleFile: "src/validate.ts",
  },
  "tsforge/no-error-stringify": {
    what: "Disallow stringifying errors with `String(error)` / `${error}` / `error.toString()` \u2014 strips the cause chain. Use a configured extractor instead.",
    bad: '\n      logger.error({ event: "error", message: String(error) });\n    ',
    good: '\n      import { getErrorMessage } from "@/lib/errors";\n      logger.error({ event: "error", message: getErrorMessage(error) });\n    ',
  },
  "tsforge/no-focused-tests": {
    what: "A focused test silently disables the rest of the file \u2014 the suite goes green having run one case.",
    bad: 'describe("cart", () => {\n  it.only("adds an item", () => {\n    expect(add(1)).toBe(1);\n  });\n});',
    good: 'describe("cart", () => {\n  it("adds an item", () => {\n    expect(add(1)).toBe(1);\n  });\n});',
    exampleFile: "src/cart.test.ts",
  },
  "tsforge/no-historical-comments": {
    what: "Comments describe the code as it is. What it used to be lives in git, and rots here.",
    bad: "// We used to call lodash here.\nexport const double = (xs: number[]): number[] => xs.map((x) => x * 2);",
    good: "// Preserves input order; callers index into the result.\nexport const double = (xs: number[]): number[] => xs.map((x) => x * 2);",
  },
  "tsforge/no-import-build-output": {
    what: "Disallow importing from build/output directories within the project. Source must import source, not compiled artifacts, to avoid stale-code drift and broken module boundaries.",
    bad: 'import { helper } from "../dist/index";\n\nexport const value = helper();',
    good: 'import { helper } from "../src/index";\n\nexport const value = helper();',
    exampleFile: "src/a.ts",
  },
  "tsforge/no-import-test-from-source": {
    what: "Source must not import test files \u2014 the test tree is not shipped, so this breaks the build.",
    bad: 'import { makeUser } from "../b.test";\n\nexport const user = makeUser();',
    good: 'import { makeUser } from "./test-support/factories";\n\nexport const user = makeUser();',
    exampleFile: "src/a.ts",
  },
  "tsforge/no-internal-api-fetch": {
    what: "Disallow Server Components from fetching the app's own /api routes \u2014 import services or ORM modules directly to avoid loopback HTTP overhead.",
    bad: 'export default async function Page() {\n  const res = await fetch("/api/users");\n  return null;\n}',
    good: 'import { listUsers } from "@/services/users";\n\nexport default async function Page() {\n  const users = await listUsers();\n\n  return null;\n}',
    exampleFile: "app/dashboard/page.tsx",
  },
  "tsforge/no-jsx-computation": {
    what: "Move complex computations out of JSX into hooks or helper functions",
    bad: "export function List({ items }: { items: number[] }) {\n  return <ul>{items.filter((i) => i > 0).map((i) => <li key={i}>{i}</li>)}</ul>;\n}",
    good: 'import { useMemo } from "react";\n\nexport function List({ items }: { items: number[] }) {\n  const visible = useMemo(() => items.filter((i) => i > 0), [items]);\n\n  return <ul>{visible.map((i) => <li key={i}>{i}</li>)}</ul>;\n}',
    exampleFile: "src/List.tsx",
  },
  "tsforge/no-loading-text-use-skeleton": {
    what: "Loading states must render a <Skeleton/>, not loading text or a spinner",
    bad: "export function View() { return <div>Loading...</div>; }",
    good: 'export function View() { return <Skeleton className="h-8 w-full" />; }',
    exampleFile: "src/views/Items/index.tsx",
  },
  "tsforge/no-narration-comments": {
    what: "Don't narrate what the next line plainly says. Comment the WHY, or delete it.",
    bad: "// Here we loop over the users\nfor (const user of users) {\n  send(user);\n}",
    good: "// Sequential on purpose: the provider rate-limits concurrent sends per account.\nfor (const user of users) {\n  send(user);\n}",
  },
  "tsforge/no-nested-db-transaction": {
    what: "Forbid invoking the outer db's `.transaction(...)` method inside a transaction callback \u2014 use the callback's `tx` parameter instead to avoid deadlocks.",
    bad: "\n      await db.transaction(async (tx) => {\n        await db.transaction(async (tx2) => {});\n      });\n    ",
    good: "\n      await db.transaction(async (tx) => {\n        await tx.transaction(async (tx2) => {});\n      });\n    ",
    exampleFile: "src/db/migrations.ts",
  },
  "tsforge/no-next-head-in-app": {
    what: "`next/head` does nothing under app/. Use the Metadata API.",
    bad: 'import Head from "next/head";\n\nexport default function Page() {\n  return <Head><title>Home</title></Head>;\n}',
    good: 'export const metadata = { title: "Home" };\n\nexport default function Page() {\n  return <main>Home</main>;\n}',
    exampleFile: "app/page.tsx",
  },
  "tsforge/no-pages-router-data-fetching-in-app": {
    what: "`getServerSideProps`/`getStaticProps` are pages-router APIs and are ignored under app/. Fetch in the component.",
    bad: "export async function getServerSideProps() {\n  return { props: { items: [] } };\n}\n\nexport default function Page() {\n  return <main />;\n}",
    good: "export default async function Page() {\n  const items = await loadItems();\n\n  return <main>{items.length}</main>;\n}",
    exampleFile: "app/page.tsx",
  },
  "tsforge/no-pr-reference-comments": {
    what: "PR and ticket numbers are not context \u2014 by the time someone reads this the link is cold. State the constraint.",
    bad: "// See PR #482 for why this is here\nexport const RETRY_LIMIT = 3;",
    good: "// Three attempts: the gateway retries twice internally, so more multiplies\n// into a thundering herd during an outage.\nexport const RETRY_LIMIT = 3;",
  },
  "tsforge/no-process-exit": {
    what: "`process.exit()` truncates in-flight work in library code. Use it only in CLI entrypoints (`src/cli.ts`, `scripts/`, `bin/`) or error-handlers; elsewhere throw and let the process unwind.",
    bad: "export function boot(ok: boolean): void {\n  if (!ok) {\n    process.exit(1);\n  }\n}",
    good: 'export function boot(ok: boolean): void {\n  if (!ok) {\n    throw new Error("boot failed: configuration invalid");\n  }\n}',
  },
  "tsforge/no-raw-sql-outside-allowlist": {
    what: "Raw `sql` templates outside the allowlist bypass the query builder's typing and escaping.",
    bad: 'import { sql } from "drizzle-orm";\n\nexport const rows = await db.execute(sql`select * from users where id = ${id}`);',
    good: "export const rows = await db.select().from(users).where(eq(users.id, id));",
    exampleFile: "src/db/queries.ts",
  },
  "tsforge/no-react-in-services": {
    what: "A service/data-layer file must not import React \u2014 keep React in components and hooks.",
    bad: 'import { useState } from "react";\n\nexport function useUserCache() {\n  const [users, setUsers] = useState<string[]>([]);\n\n  return { users, setUsers };\n}',
    good: "// Plain module state \u2014 no React in the service layer. The component wraps\n// this in its own useState/useSyncExternalStore.\nlet users: string[] = [];\n\nexport function getUsers(): string[] {\n  return users;\n}\n\nexport function setUsers(next: string[]): void {\n  users = next;\n}",
    exampleFile: "src/services/users.ts",
  },
  "tsforge/no-real-network-in-unit-tests": {
    what: "A unit test that hits the network is slow, flaky and fails offline. Stub the boundary.",
    bad: 'it("loads the user", async () => {\n  const res = await fetch("https://api.example.com/users/1");\n\n  expect(res.ok).toBe(true);\n});',
    good: 'it("loads the user", async () => {\n  const res = await loadUser("1", { fetch: stubFetch });\n\n  expect(res.ok).toBe(true);\n});',
    exampleFile: "src/user.test.ts",
  },
  "tsforge/no-self-import": {
    what: "A module importing from itself is a circular self-reference \u2014 the binding does not exist at runtime.",
    bad: 'import { helper } from "./example";\n\nexport function helper2(): number {\n  return helper() + 1;\n}',
    good: "function helper(): number {\n  return 1;\n}\n\nexport function helper2(): number {\n  return helper() + 1;\n}",
  },
  "tsforge/no-separate-model-interfaces": {
    what: "Disallow TypeScript interfaces that duplicate the shape of a runtime schema with a matching name. Use `typeof Schema.static` (or your project's equivalent) instead.",
    bad: 'import { t } from "elysia";\n\nexport const UserSchema = t.Object({ id: t.String(), name: t.String() });\n\nexport interface User {\n  id: string;\n  name: string;\n}',
    good: 'import { t } from "elysia";\n\nexport const UserSchema = t.Object({ id: t.String(), name: t.String() });\n\n// Derived from the schema, so the type cannot drift from what is validated.\nexport type User = typeof UserSchema.static;',
    procedure:
      "Derive the type from the schema with `typeof Schema.static` rather than declaring a parallel interface. Renaming the interface silences the rule but leaves two definitions that drift apart \u2014 the schema validates one shape while the type promises another.",
  },
  "tsforge/no-spawn-with-shell": {
    what: "`shell: true` runs the string through a shell, so any interpolated value can inject commands. Drop it and pass the program and its arguments as an array.",
    bad: 'import { spawn } from "node:child_process";\n\nexport function run(dir: string) {\n  return spawn("ls -la " + dir, { shell: true });\n}',
    good: 'import { spawn } from "node:child_process";\n\nexport function run(dir: string) {\n  // Same command, no shell: the directory can no longer inject one.\n  return spawn("ls", ["-la", dir]);\n}',
    exampleFile: "src/runner.ts",
  },
  "tsforge/no-state-in-component-body": {
    what: "State hooks must be in .hooks.ts files, not directly in components",
    bad: "",
    good: "",
    procedure:
      "1) Create/open `Component.hooks.ts` next to the component. 2) Move the state/effect hooks into a `useComponent()` custom hook that returns the values and handlers the JSX needs. 3) Call the hook once at the top of the component and destructure. (`useId`/`useTransition`/`useDeferredValue` may stay inline.)",
  },
  "tsforge/one-component-per-file": {
    what: "One top-level React component per .tsx file — a second PascalCase component in the same file fails the gate.",
    bad: "export function Alpha() { return <div />; }\nexport function Beta() { return <span />; }",
    good: 'import { Beta } from "./Beta";\nexport function Alpha() { return <div><Beta /></div>; }',
    exampleFile: "src/views/Feed/components/Alpha.tsx",
  },
  "tsforge/no-user-controlled-fetch-url": {
    what: "The request ORIGIN must be fixed in source. Interpolating the path is fine; interpolating the host is not. There is no allowlist or builder to opt into \u2014 write the host literally.",
    bad: "export async function load(url: string, host: string) {\n  await fetch(url);\n\n  return fetch(`https://${host}/todos`);\n}",
    good: "export async function load(id: string) {\n  await fetch(`/api/todos/${id}`);\n\n  return fetch(`https://api.example.com/v1/${id}`);\n}",
    procedure:
      'Put the whole origin before the first ${...} and close it with / ? or # \u2014 `https://api.example.com${p}` is still rejected because p="@evil.com/x" rewrites the host through userinfo. For a caller-supplied host, validate it against a fixed allowlist yourself and branch to literal URLs.',
  },
  "tsforge/no-user-controlled-redirect": {
    what: "A runtime-controlled redirect target lets an attacker bounce your users anywhere. Redirect to a literal path, or map the caller's value through a fixed allowlist of destinations.",
    bad: 'import { redirect } from "next/navigation";\nexport function go(target: string) { redirect(target); }',
    good: 'import { redirect } from "next/navigation";\nexport function go() { redirect("/dashboard"); }',
    exampleFile: "src/actions.ts",
  },
  "tsforge/no-user-input-in-system-prompt": {
    what: "Warn when a system prompt is built by string interpolation/concatenation \u2014 splicing request data into the system role enables prompt injection. Keep the system prompt constant; pass user input as a user message.",
    bad: "const result = generateText({\n  model,\n  system: `You are a ${role} assistant.`,\n  prompt: userInput,\n});",
    good: 'const result = generateText({\n  model,\n  system: SYSTEM_PROMPT,\n  messages: [{ role: "user", content: userInput }],\n});',
    exampleFile: "src/server/run.ts",
  },
  "tsforge/prefer-direct-return": {
    what: "Inside Elysia route handlers, return values directly instead of wrapping them in `new Response(...)` or `Response.json(...)` \u2014 Elysia handles serialization and content-type automatically.",
    bad: '\n      const app = new Elysia();\n      app.get("/users", () => {\n        return Response.json({ id: 1, name: "Alice" });\n      });\n    ',
    good: '\n      const app = new Elysia();\n      app.get("/users", () => {\n        return { id: 1, name: "Alice" };\n      });\n    ',
  },
  "tsforge/prefer-early-return": {
    what: "Guard and return early instead of wrapping the body in a trailing `if` \u2014 nesting hides the happy path.",
    bad: "export function run(x: number): number {\n  if (x > 0) {\n    const doubled = x * 2;\n    const squared = doubled * doubled;\n\n    return squared;\n  }\n}",
    good: "export function run(x: number): number {\n  if (x <= 0) {\n    return 0;\n  }\n\n  const doubled = x * 2;\n  const squared = doubled * doubled;\n\n  return squared;\n}",
  },
  "tsforge/prefer-lazy-use-state-init": {
    what: "Prefer lazy useState initializers when parsing localStorage/sessionStorage \u2014 avoids re-parsing on every render.",
    bad: '"use client";\nimport { useState } from "react";\nexport function Panel() {\n  const [config] = useState(JSON.parse(localStorage.getItem("cfg") ?? "{}"));\n  return null;\n}',
    good: '"use client";\nimport { useState } from "react";\nexport function Panel() {\n  const [config] = useState(() => JSON.parse(localStorage.getItem("cfg") ?? "{}"));\n  return null;\n}',
    exampleFile: "src/Panel.tsx",
  },
  "tsforge/prefer-throw-status": {
    what: "Inside Elysia route handlers, prefer `throw status(...)` over try/catch blocks that build their own Response \u2014 local catches bypass Elysia's typed onError pipeline.",
    bad: '\n      const app = new Elysia();\n      app.post("/users", async () => {\n        try {\n          return await createUser();\n        } catch (e) {\n          return new Response("Error", { status: 500 });\n        }\n      });\n    ',
    good: 'const app = new Elysia();\n\napp.post("/users", async ({ status }) => {\n  const user = await createUser();\n\n  if (user === null) {\n    throw status(500, "could not create user");\n  }\n\n  return user;\n});',
  },
  "tsforge/queue-options-must-set-removeoncomplete": {
    what: "Every `<queue>.add(...)` must configure `removeOnComplete` (per-call or via `defaultJobOptions`) so completed jobs don't accumulate in Redis.",
    bad: '\n      import { Queue } from "bullmq";\n      const emailQueue = new Queue("email");\n      emailQueue.add("send", {});\n    ',
    good: '\n      import { Queue } from "bullmq";\n      const emailQueue = new Queue("email");\n      emailQueue.add("send", {}, { removeOnComplete: true });\n    ',
  },
  "tsforge/queue-options-must-set-removeonfail": {
    what: "Every `<queue>.add(...)` must configure `removeOnFail` (per-call or via `defaultJobOptions`) so failed jobs don't accumulate in Redis.",
    bad: '\n      import { Queue } from "bullmq";\n      const emailQueue = new Queue("email");\n      emailQueue.add("send", {});\n    ',
    good: '\n      import { Queue } from "bullmq";\n      const emailQueue = new Queue("email");\n      emailQueue.add("send", {}, { removeOnFail: 5000 });\n    ',
  },
  "tsforge/require-completion-token-limit": {
    what: "Require a token limit (maxTokens / max_tokens) on AI completion calls to bound runaway cost and latency.",
    bad: 'import { generateText } from "ai";\nexport async function run(model: unknown) {\n  return generateText({ model, prompt: "hi" });\n}',
    good: 'import { generateText } from "ai";\nexport async function run(model: unknown) {\n  return generateText({ model, prompt: "hi", maxTokens: 256 });\n}',
    exampleFile: "src/server/run.ts",
  },
  "tsforge/require-elysia-plugin-name": {
    what: "Exported Elysia plugin instances must declare `new Elysia({ name: '...' })` so the runtime can deduplicate plugin re-imports.",
    bad: "\n      export const plugin = new Elysia();\n    ",
    good: '\n      export const plugin = new Elysia({ name: "auth-plugin" });\n    ',
  },
  "tsforge/require-event-field": {
    what: "Require structured logger calls to include an `event` field in their payload, so log searches in ELK/Datadog/Loki don't fall back to substring match.",
    bad: '\n      logger.info({ message: "Something happened" });\n    ',
    good: '\n      logger.info({ event: "user_created", userId: 123 });\n    ',
  },
  "tsforge/require-fastify-plugin-name": {
    what: "fastify-plugin (fp) wrappers must include a `name` option so Fastify can deduplicate plugin registration.",
    bad: '\nimport fp from "fastify-plugin";\nexport default fp(async function dbPlugin(fastify) {\n  fastify.decorate("db", {});\n});\n',
    good: '\nimport fp from "fastify-plugin";\nexport default fp(async function dbPlugin(fastify) {\n  fastify.decorate("db", {});\n}, { name: "db-connector" });\n',
    exampleFile: "src/plugins/db.ts",
  },
  "tsforge/require-hooks-before-routes": {
    what: "Elysia hooks (onError, onBeforeHandle, etc.) must register before any route methods on the same instance \u2014 top-down waterfall semantics mean a hook registered after a route does not apply to it.",
    bad: '\n      const app = new Elysia()\n        .get("/", () => "hello")\n        .onError((ctx) => {});\n    ',
    good: '\n      const app = new Elysia()\n        .onError((ctx) => {})\n        .get("/", () => "hello");\n    ',
  },
  "tsforge/require-route-schema": {
    what: "Fastify POST/PUT/PATCH routes must declare schema.body; GET/DELETE routes must declare schema.querystring or schema.params.",
    bad: 'import Fastify from "fastify";\n\nconst fastify = Fastify();\n\nfastify.post("/users", { schema: {} }, async () => ({ ok: true }));',
    good: 'import Fastify from "fastify";\n\nconst fastify = Fastify();\n\nfastify.post(\n  "/users",\n  {\n    schema: {\n      body: {\n        type: "object",\n        required: ["email"],\n        properties: { email: { type: "string", format: "email" } },\n      },\n    },\n  },\n  async () => ({ ok: true })\n);',
    procedure:
      "Describe every field the route accepts. An empty or permissive schema satisfies the rule while validating nothing \u2014 the point is that unexpected input is REJECTED, not that a schema key exists.",
    exampleFile: "src/routes/users.ts",
  },
  "tsforge/server-action-requires-authz": {
    what: "A server action is a public HTTP endpoint. Authorize before doing work.",
    bad: "",
    good: "",
    exampleFile: "app/actions/posts.ts",
    procedure:
      'A server action is a public HTTP endpoint; the `"use server"` directive does not restrict who can call it. Start the body with your authorization helper, fail closed if it returns nothing, and scope every query to the resolved principal.',
  },
  "tsforge/server-only-modules-import-server-only": {
    what: 'App-router server modules must import `"server-only"` so accidental client bundling fails at build time.',
    bad: "export default async function Page() { return null; }",
    good: 'import "server-only";\nexport default async function Page() { return null; }',
    exampleFile: "app/dashboard/page.tsx",
  },
  "tsforge/test-inject-must-close-app": {
    what: "Test files using fastify.inject must register teardown that calls app.close() to drain connections.",
    bad: '\nimport { test } from "node:test";\nimport { buildApp } from "./app";\ntest("login", async () => {\n  const app = buildApp();\n  await app.inject({ method: "GET", url: "/health" });\n});\n',
    good: '\nimport { test } from "node:test";\nimport { buildApp } from "./app";\ntest("login", async (t) => {\n  const app = buildApp();\n  t.after(() => app.close());\n  await app.inject({ method: "GET", url: "/health" });\n});\n',
    exampleFile: "src/routes/users.test.ts",
  },
  "tsforge/upload-must-set-limits": {
    what: "Multipart upload handlers should declare `limits` or `maxFileSize` to bound request size.",
    bad: 'import multipart from "@fastify/multipart";\nexport async function handleUpload(request: { file: () => Promise<unknown> }) {\n  return request.file();\n}',
    good: 'import multipart from "@fastify/multipart";\n\nexport async function registerUploads(app: FastifyInstance) {\n  await app.register(multipart, { limits: { fileSize: 5_000_000, files: 1 } });\n\n  app.post("/upload", async (request) => request.file());\n}',
    exampleFile: "src/routes/upload.ts",
  },
  "tsforge/webhook-must-verify-signature-before-parse": {
    what: "Webhook handlers must verify signatures before calling `.json()` on the request body.",
    bad: "export async function handleWebhook(request: Request) {\n  const payload = await request.json();\n  verifySignature(payload);\n}",
    good: "export async function handleWebhook(request: Request) {\n  verifySignature(request);\n  const payload = await request.json();\n  return payload;\n}",
    exampleFile: "src/routes/stripe-webhook.ts",
  },
  "tsforge/worker-must-implement-close": {
    what: "Classes that own a `new Worker(...)` instance must declare a close-equivalent method for graceful shutdown.",
    bad: '\n      import { Worker } from "bullmq";\n      export class EmailService {\n        private worker = new Worker("email", async () => {});\n      }\n    ',
    good: '\n      import { Worker } from "bullmq";\n      export class EmailService {\n        private worker = new Worker("email", async () => {});\n        async close() {\n          await this.worker.close();\n        }\n      }\n    ',
  },
  "tsforge/worker-must-listen-failed": {
    what: "A BullMQ worker swallows failures unless a `failed` listener is attached. NOTE: this rule only recognises the CHAINED form \u2014 `.on()` on a separate statement is not detected, even though it is equivalent.",
    bad: 'import { Worker } from "bullmq";\n\nconst worker = new Worker("emails", handler);',
    good: 'import { Worker } from "bullmq";\n\nconst worker = new Worker("emails", handler).on("failed", (job, err) => {\n  logger.error({ event: "job.failed", jobId: job?.id, cause: err });\n});',
    procedure:
      'Chain `.on("failed", ...)` directly onto `new Worker(...)`. Registering the same listener on a following statement is functionally identical but this rule does not currently detect it.',
  },
  "tsforge/no-template-trim-empty-ternary": {
    what: "Inline `x.trim() === '' ? fallback : x.trim()` is unreadable and evaluates twice. Extract a named utility.",
    bad: "",
    good: "",
    procedure:
      "Move it to a named helper such as `textOrFallback(value, fallback)` in your utils module and call that. Naming the intent is the point; the ternary hides it.",
  },
  "tsforge/account-scoped-tables-require-where": {
    what: "A query against an account-scoped table must filter by the scope column, or one tenant reads another's rows.",
    bad: "",
    good: "",
    procedure:
      "Every read of an account-scoped table must filter by its scope column, or one tenant sees another's rows. Add it to the query itself \u2014 `.where(eq(invoices.accountId, accountId))` \u2014 rather than filtering the results afterwards. Which tables are scoped, and under which column, comes from this rule's own configuration.",
  },
  "tsforge/update-delete-must-have-where": {
    what: "An update or delete with no `where` rewrites or removes the ENTIRE table.",
    bad: "await db.delete(users);",
    good: "await db.delete(users).where(eq(users.id, id));",
  },
  "tsforge/update-delete-account-scoped-must-filter-scope": {
    what: "An update/delete on an account-scoped table must filter by the scope column, not just the row id.",
    bad: "",
    good: "",
    procedure:
      "A row id is not enough on an account-scoped table: ids are guessable and an id-only `where` lets one tenant modify another's row. Filter by BOTH \u2014 `.where(and(eq(invoices.id, id), eq(invoices.accountId, accountId)))`.",
  },
  "tsforge/relations-must-cover-fks": {
    what: "Every foreign key needs a matching `relations()` entry or joins silently fall back to manual, untyped queries.",
    bad: "",
    good: "",
    procedure:
      "Declare the relation next to the table: `export const invoiceRelations = relations(invoices, ({ one }) => ({ account: one(accounts, { fields: [invoices.accountId], references: [accounts.id] }) }));` \u2014 one entry per FK column.",
  },
  "tsforge/schema-files-must-not-import-driver": {
    what: "A schema file importing the driver drags a live connection into every consumer, including the migration generator.",
    bad: "",
    good: "",
    procedure:
      "Keep schema files declarative: import only from `drizzle-orm` and its dialect's column helpers. Create the client in a separate module (e.g. `src/db/client.ts`) and import the schema INTO it, never the reverse.",
  },
  "tsforge/schema-files-must-only-export-schema": {
    what: "A schema file must export only tables, relations and types \u2014 anything else makes it a runtime dependency of the migration tooling.",
    bad: "",
    good: "",
    procedure:
      "Move helpers, queries and constants out of the schema file into a sibling module. The schema is read by drizzle-kit at build time; extra exports pull their whole import graph in with them.",
  },
  "tsforge/tables-must-have-timestamps": {
    what: "Every table needs created/updated timestamps \u2014 without them you cannot audit, order or debug a row's history.",
    bad: "",
    good: "",
    procedure:
      'Add `createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow()` and an `updatedAt` with `.$onUpdate(() => new Date())`, so the update stamp maintains itself.',
  },
  "tsforge/timestamp-must-specify-mode": {
    what: "A timestamp column without an explicit `mode` returns a different JS type per driver.",
    bad: "",
    good: "",
    procedure:
      'Pass the mode explicitly: `timestamp("created_at", { mode: "date" })` for `Date`, or `{ mode: "string" }` for ISO strings. Pick one and use it consistently across the schema.',
  },
  "tsforge/prefer-destructured-context": {
    what: "Destructure the Elysia context in the handler signature \u2014 it documents what the handler actually uses.",
    bad: "",
    good: "",
    procedure:
      "Destructure the Elysia context in the handler signature so the handler declares what it uses: `({ set, body }) => ...` instead of taking `ctx` and reaching into it. It documents the dependency and keeps handlers easy to test.",
  },
  "tsforge/prefer-static-services": {
    what: "Build service instances once at module scope; constructing per request adds latency and defeats connection reuse.",
    bad: "",
    good: "",
    procedure:
      "Hoist the instance out of the handler: create it once at module scope and close over it, so each request reuses the same client and its pool.",
  },
  "tsforge/error-handler-must-set-status": {
    what: "An error handler that does not set a status returns 200 with an error body \u2014 clients treat the failure as success.",
    bad: "",
    good: "",
    procedure:
      "Set the code before replying: `reply.code(err.statusCode ?? 500).send({ message })`. Without it Fastify keeps the default 200.",
  },
  "tsforge/prefer-return-over-reply-send": {
    what: "Return the payload instead of calling `reply.send()` \u2014 returning keeps the handler's type checkable and composes with hooks.",
    bad: "",
    good: "",
    procedure:
      "Replace `reply.send(payload)` with `return payload`. Use `reply.code(...)` only to set the status, then return the body.",
  },
  "tsforge/require-fp-for-shared-plugins": {
    what: "A plugin that registers shared decorators must be wrapped in `fastify-plugin`, or its registrations stay trapped in a child scope.",
    bad: "",
    good: "",
    procedure:
      'Wrap the export: `export default fp(async (app) => { app.decorate("db", db); });`. Without `fp`, Fastify encapsulates the plugin and nothing it decorates is visible to sibling routes.',
  },
  "tsforge/require-response-schema": {
    what: "A route without a response schema is unvalidated and unserialised \u2014 Fastify cannot fast-serialise it and the contract is undocumented.",
    bad: "",
    good: "",
    procedure:
      "Add a `schema.response` map keyed by status code to the route options, e.g. `{ schema: { response: { 200: UserSchema } } }`.",
  },
  "tsforge/static-translation-key-exists": {
    what: "A translation key built at runtime cannot be checked, so a missing key ships as raw key text to users.",
    bad: "",
    good: "",
    procedure:
      'Use a literal key (`t("cart.empty")`) so it can be verified against the dictionary. When a key genuinely varies, map the variants to literals in a lookup object and index that.',
  },
  "tsforge/auth-cookie-must-set-samesite": {
    what: "An auth cookie without `sameSite` is sent on cross-site requests \u2014 the classic CSRF opening.",
    bad: 'setCookie("session", token, { httpOnly: true, secure: true });',
    good: 'setCookie("session", token, {\n  httpOnly: true,\n  secure: true,\n  sameSite: "lax",\n});',
    procedure:
      'Set `sameSite: "lax"` (or `"strict"` if no cross-site navigation needs the session) when writing the cookie.',
  },
  "tsforge/auth-cookie-must-set-maxage-or-expires": {
    what: "A session cookie with no lifetime lives until the browser closes \u2014 which on a phone is never.",
    bad: 'setCookie("session", token, {\n  httpOnly: true,\n  secure: true,\n  sameSite: "lax",\n});',
    good: 'setCookie("session", token, {\n  httpOnly: true,\n  secure: true,\n  sameSite: "lax",\n  maxAge: 60 * 60,\n});',
    procedure:
      "Set `maxAge` (seconds) or `expires` when writing the cookie, and keep it in step with the token's own expiry.",
  },
  "tsforge/jwt-must-verify-not-decode": {
    what: "`decode` reads the payload WITHOUT checking the signature, so a forged token is accepted.",
    bad: "const claims = jwt.decode(token);",
    good: "const claims = jwt.verify(token, secret);",
  },
  "tsforge/mutation-should-revalidate-cache": {
    what: "A mutation that does not revalidate leaves the UI showing stale data until something else refreshes it.",
    bad: "",
    good: "",
    procedure:
      'After the write, call `revalidatePath("/things")` or `revalidateTag("things")` for the data the mutation invalidated.',
  },
  "tsforge/no-secret-props-to-client": {
    what: "A secret-looking prop passed into JSX crosses the server/client boundary and lands in the browser payload.",
    bad: "",
    good: "",
    procedure:
      "Keep the secret on the server: use it there and pass only the derived, non-sensitive result as a prop.",
  },
  "tsforge/pkce-required-for-oidc": {
    what: "Without PKCE an intercepted authorization code can be redeemed by an attacker.",
    bad: "",
    good: "",
    procedure:
      "Generate a `code_verifier`, send its S256 `code_challenge` on the authorize request, and pass the verifier on the token exchange.",
  },
  "tsforge/state-must-be-redis-backed": {
    what: "OAuth `state` held only in a cookie can be replayed or dropped; it must be stored server-side so it can be consumed exactly once.",
    bad: "",
    good: "",
    procedure:
      "Write the state to Redis with a short TTL before redirecting, then DELETE it on callback and reject if it was already gone.",
  },
  "tsforge/state-ttl-bounded": {
    what: "An unbounded OAuth state TTL leaves replayable handles alive indefinitely.",
    bad: "",
    good: "",
    procedure:
      "Set an explicit short TTL \u2014 a few minutes covers a real login. The state only has to survive one redirect round trip.",
  },
  "tsforge/forwardref-display-name": {
    what: "A forwardRef component with no displayName shows as `ForwardRef` in React DevTools and error boundaries.",
    bad: "",
    good: "",
    procedure:
      'Assign it after the definition: `Input.displayName = "Input";` \u2014 React cannot infer a name through forwardRef.',
  },
  "tsforge/no-cross-feature-imports": {
    what: "Importing across feature folders couples them and creates import cycles as both grow.",
    bad: "",
    good: "",
    procedure:
      "Move the shared code into a shared module both features import, or expose it through the owning feature's public index. Do not reach into another feature's internals.",
  },
  "tsforge/prefix-query-key-must-use-set-queries-data": {
    what: "`setQueryData` with a partial key matches nothing \u2014 a prefix is a filter, not a key.",
    bad: "",
    good: "",
    procedure:
      'Use the matcher API for prefixes: `queryClient.setQueriesData({ queryKey: ["todos"] }, updater)`. Keep `setQueryData` for one exact key.',
  },
  "tsforge/test-file-mirrors-source": {
    what: "A test whose path does not mirror its source is orphaned \u2014 nobody finds it when the source changes.",
    bad: "",
    good: "",
    procedure:
      "Put the test at the mirrored path for this project (either beside the source or under tests/ following the same folders) so the pair moves together.",
  },
  "tsforge/no-mixed-three-entrypoints": {
    what: "Import Three.js only from `three` and `three/addons/...`. `three/examples/jsm/`, `three/src/`, and CDN URLs can load a second copy of the library.",
    bad: 'import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";',
    good: 'import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";',
  },
  "tsforge/prefer-named-three-imports": {
    what: "Prefer named imports from `three` over `import * as THREE` so each symbol is visible and tree-shakeable.",
    bad: 'import * as THREE from "three";\nconst v = new THREE.Vector3();\nconst c = new THREE.Color();',
    good: 'import { Color, Vector3 } from "three";\nconst v = new Vector3();\nconst c = new Color();',
  },
  "tsforge/no-global-three": {
    what: 'Do not use a script-tag global `THREE` or `require("three")`. Import from the `three` package so every module shares one copy.',
    bad: "const v = new THREE.Vector3();",
    good: 'import { Vector3 } from "three";\nconst v = new Vector3();',
  },
  "tsforge/no-direct-children-mutation": {
    what: "Do not mutate `Object3D.children` as an array. Use `add()` / `remove()` so parent/child links stay in sync.",
    bad: 'import { Scene, Mesh } from "three";\nconst scene = new Scene();\nconst mesh = new Mesh();\nscene.children.push(mesh);',
    good: 'import { Scene, Mesh } from "three";\nconst scene = new Scene();\nconst mesh = new Mesh();\nscene.add(mesh);',
  },
  "tsforge/require-projection-update": {
    what: "After writing `camera.aspect`, call `camera.updateProjectionMatrix()` or the frustum will not match the new aspect ratio.",
    bad: 'import { PerspectiveCamera } from "three";\nconst camera = new PerspectiveCamera();\ncamera.aspect = 1.5;',
    good: 'import { PerspectiveCamera } from "three";\nconst camera = new PerspectiveCamera();\ncamera.aspect = 1.5;\ncamera.updateProjectionMatrix();',
  },
  "tsforge/require-three-dispose-contract": {
    what: "A class that constructs Three.js GPU resources must declare `dispose()` (or destroy/onModuleDestroy). Dropping the JS reference does not free VRAM.",
    bad: 'import { BoxGeometry, MeshBasicMaterial } from "three";\nclass GridView {\n  private geometry = new BoxGeometry();\n  private material = new MeshBasicMaterial();\n}',
    good: 'import { BoxGeometry, MeshBasicMaterial } from "three";\nclass GridView {\n  private geometry = new BoxGeometry();\n  private material = new MeshBasicMaterial();\n  dispose() {\n    this.geometry.dispose();\n    this.material.dispose();\n  }\n}',
  },
  "tsforge/prefer-three-load-async": {
    what: "Prefer `loader.loadAsync()` over callback `load()` so failures compose with Promises instead of a detached error callback.",
    bad: 'import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\nconst loader = new GLTFLoader();\nloader.load("/model.glb", (gltf) => {\n  use(gltf);\n}, undefined, (err) => {\n  throw err;\n});',
    good: 'import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\nconst loader = new GLTFLoader();\nconst gltf = await loader.loadAsync("/model.glb");\nuse(gltf);',
  },
  "tsforge/require-three-loader-error-path": {
    what: "A Three.js loader `.load(url, onLoad)` call must pass an `onError` callback (4th argument), or use `loadAsync()` and handle the rejection.",
    bad: 'import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\nconst loader = new GLTFLoader();\nloader.load("/model.glb", (gltf) => {\n  use(gltf);\n});',
    good: 'import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\nconst loader = new GLTFLoader();\nloader.load("/model.glb", (gltf) => {\n  use(gltf);\n}, undefined, (err) => {\n  throw err;\n});',
  },
  "tsforge/require-instance-buffer-update": {
    what: "After `InstancedMesh.setMatrixAt()` / `setColorAt()`, set `instanceMatrix.needsUpdate` / `instanceColor.needsUpdate` so GPU buffers refresh.",
    bad: 'import { InstancedMesh, Matrix4 } from "three";\nconst mesh = new InstancedMesh();\nconst matrix = new Matrix4();\nfor (let i = 0; i < 10; i++) {\n  mesh.setMatrixAt(i, matrix);\n}',
    good: 'import { InstancedMesh, Matrix4 } from "three";\nconst mesh = new InstancedMesh();\nconst matrix = new Matrix4();\nfor (let i = 0; i < 10; i++) {\n  mesh.setMatrixAt(i, matrix);\n}\nmesh.instanceMatrix.needsUpdate = true;',
  },
  "tsforge/no-unbounded-device-pixel-ratio": {
    what: "Do not pass unbounded `window.devicePixelRatio` to `setPixelRatio`. Cap it so high-DPI displays cannot explode GPU memory.",
    bad: 'import { WebGLRenderer } from "three";\nconst renderer = new WebGLRenderer();\nrenderer.setPixelRatio(window.devicePixelRatio);',
    good: 'import { WebGLRenderer } from "three";\nconst renderer = new WebGLRenderer();\nrenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));',
  },
  "tsforge/no-disabled-frustum-culling": {
    what: "Leave `Object3D.frustumCulled` at its default (`true`) unless a custom shader invalidates geometric bounds.",
    bad: 'import { Mesh } from "three";\nconst mesh = new Mesh();\nmesh.frustumCulled = false;',
    good: 'import { Mesh } from "three";\nconst mesh = new Mesh();\nmesh.frustumCulled = true;',
  },
};
