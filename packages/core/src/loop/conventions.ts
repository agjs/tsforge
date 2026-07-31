/**
 * The boringstack CONVENTION library — the "how to write it right" knowledge the
 * model needs AT write-time, distilled from boringstack's `docs/agents/*` and kept
 * in lockstep with what the gate enforces. Two delivery paths use it:
 *   • PUSH (primary) — the harness injects the relevant guide the moment the model
 *     does the matching thing (e.g. creates its first component), so it writes
 *     compliant code the FIRST time instead of writing wrong then refactoring.
 *   • PULL (secondary) — the `pull_conventions` tool lets the model fetch a guide
 *     on demand for the long tail the harness can't pre-anticipate.
 * Concise on purpose: a local model absorbs a focused 8-line guide, not a 368-line
 * wall. Each guide maps 1:1 to the rules that reject its violation.
 */

import type { IConventionProvider } from "./conventions-provider";

/** The convention topics the model can be handed or pull. Single source of truth:
 *  the const tuple drives both the type and the runtime list (no `as` cast). */
const TOPICS = [
  "component-anatomy",
  "file-layout",
  "jsx",
  "state",
  "no-casts",
  "routing",
  "forms",
  "data-fetching",
  "lint-gotchas",
  "testing",
  "api-service",
  "i18n",
  "design-tokens",
  "theming",
  "responsive",
  "accessibility",
  "components-ui",
] as const;

export type ConventionTopic = (typeof TOPICS)[number];

/** Membership set for the topic guard — a `Set<string>` so the check is a clean
 *  `.has()` (no `as` cast, no `.some()` that unicorn flags). */
const TOPIC_SET = new Set<string>(TOPICS);

/** topic → the enforced-rule(s) it prevents, for cross-referencing gate errors. */
export const TOPIC_RULES: Readonly<Record<ConventionTopic, readonly string[]>> =
  {
    "component-anatomy": [
      "component-folder-structure",
      "one-component-per-file",
      "index-must-reexport-default",
    ],
    "file-layout": ["component-file-purity"],
    jsx: ["no-jsx-computation", "no-inline-jsx-functions"],
    state: ["no-state-in-component-body", "max-hooks-per-file"],
    "no-casts": ["no-restricted-syntax", "no-non-null-assertion"],
    routing: ["component-folder-structure"],
    forms: [],
    // `no-unnecessary-condition` on an apiClient call is the tell that the model
    // guarded `response.error` — this stack throws on errors, so that guard is dead.
    // Mapping it here pushes the data-fetching guide on the FIRST such red.
    "data-fetching": ["no-unnecessary-condition"],
    // The strict-lint rules a fresh feature trips most (measured on a live build): floating/
    // un-awaited promises, void-returning expressions used as values, errors stringified into
    // logs, and repeated string literals. None are structural — they're write-time habits the
    // model gets wrong then grinds down one gate at a time.
    "lint-gotchas": [
      "await-thenable",
      "no-floating-promises",
      "no-confusing-void-expression",
      "no-error-stringify",
      "no-duplicate-string",
    ],
    // Tests were 61% of the edits on a live CRUD build (measured) — the model doesn't
    // know the stack's test idioms so it flails: guesses .test.ts vs .test.tsx (and makes
    // BOTH), reinvents the api-client mock (getting `any`-typed `data`), uses the wrong
    // vi mock method. These rules fire on those mistakes; the guide teaches the idiom.
    testing: [
      "test-sibling-required",
      "test-file-mirrors-source",
      "no-focused-tests",
      "no-conditional-expect",
      "no-real-network-in-unit-tests",
      "fake-timers-must-be-restored",
      // build16's final blocker (9× in one row-hook test): empty placeholder callbacks. The
      // testing guide teaches `vi.fn()` for these, so map the rule here to re-push it reactively.
      "no-empty-function",
    ],
    // The audit-event rule is a boringstack-OWN eslint rule (not a tsforge meta-rule), so it
    // isn't keyed here for the reactive PUSH — the front-loaded guide is the delivery path.
    "api-service": [],
    // The DOMINANT recurring error on a live near-green build (measured: 19× in one run — it
    // trapped the model oscillating around 1 error): the model pre-declares locale keys it never
    // references, so each is a `i18n-locale-keys-used` dead-key error. Both i18n directions map here
    // so EITHER pushes the guide: `i18n-locale-keys-used` (defined→used, the dead-key trap) and
    // `static-translation-key-exists` (used→defined, a `t()` whose key isn't in the locale files).
    i18n: ["i18n-locale-keys-used", "static-translation-key-exists"],
    // Styling/theming/responsive/composition have no dedicated lint rule — they're front-loaded
    // via buildConventionGuides (like api-service), so an empty rule list here.
    "design-tokens": [],
    theming: [],
    responsive: [],
    // Accessibility maps to the eslint-plugin-jsx-a11y rules the gate runs as ERRORS, so the guide
    // PUSHes the moment the model trips one (bare names — topicForRule strips the jsx-a11y/ prefix).
    accessibility: [
      "no-static-element-interactions",
      "click-events-have-key-events",
      "no-noninteractive-element-interactions",
      "label-has-associated-control",
      "interactive-supports-focus",
      "alt-text",
      "anchor-has-content",
      "heading-has-content",
      "aria-props",
      "aria-role",
      "aria-unsupported-elements",
      "role-has-required-aria-props",
      "role-supports-aria-props",
      "no-redundant-roles",
      "anchor-is-valid",
      "img-redundant-alt",
    ],
    "components-ui": [],
  };

const GUIDES: Readonly<Record<ConventionTopic, string>> = {
  "component-anatomy":
    "COMPONENT ANATOMY (boringstack). A feature lives in `src/features/<feature>/`. " +
    "Components go under `src/features/<feature>/components/<Name>/`, and component-folder-" +
    "structure requires the FULL sibling set — create ALL of them or the gate rejects the " +
    "folder ('missing required siblings'): `<Name>.tsx` (renders props, does NOT own state), " +
    "`<Name>.hooks.ts` (all state/effects/memo — never in the body), `<Name>.types.ts` (its " +
    "Props interface), `<Name>.stories.tsx` (a Storybook story — REQUIRED, easy to forget), " +
    "`<Name>.test.tsx` (or `.test.ts`), and `index.ts` (`export { default as <Name> } from " +
    '"./<Name>"`). ONE component per file. Feature-level files sit at `src/features/<feature>/`: ' +
    "`<Feature>.types.ts`, `<Feature>.constants.ts`, `<Feature>.queries.ts`, " +
    "`<Feature>.mutations.ts`. shadcn primitives in `src/components/ui/` are exempt.",
  "file-layout":
    "FILE PURITY (boringstack). A component `.tsx` holds ONLY imports + the component " +
    "— nothing else atop it. Move each out and import it back: a type → " +
    "`<feature>.types.ts`; a constant / label-map / column-spec → " +
    "`<feature>.constants.ts` (`as const`); a pure helper (formatX, timeAgo) → " +
    "`src/lib/<name>.ts`. Inline types/constants/helpers are a gate error " +
    "(component-file-purity).",
  jsx:
    "JSX (boringstack). No COMPUTATION inside JSX — the markup only READS " +
    "already-computed values. A derived value → a `useMemo` in `<feature>.hooks.ts`; " +
    "a pure transform → a function in `src/lib`. A simple ternary is fine; a " +
    "`.map()`/`.filter()`/arithmetic/`Object.entries()` in the markup is not (extract " +
    "it). Every `<button>` needs an explicit `type`. A function passed to a JSX prop " +
    "(`onClick`, `onChange`, `onSubmit`) must be a STABLE reference — `react/jsx-no-bind` " +
    "rejects BOTH an inline arrow (`onClick={() => …}`) AND a plain arrow defined in the " +
    "component body (it's recreated every render). Make it stable: for a list ROW, give " +
    "the row its own component with an `onEdit(id)`/`onDelete(id)` prop and pass that prop " +
    "straight to `onClick`; the parent supplies each callback via `useCallback` in " +
    "`<feature>.hooks.ts`. A handler needing an argument → `useCallback(() => onEdit(id), " +
    "[onEdit, id])` in the row's hook, not an inline `() => onEdit(id)` in the markup.",
  state:
    "STATE (boringstack). ALL `useState`/`useReducer`/`useEffect`/`useMemo`/" +
    "`useCallback` live in `<feature>.hooks.ts`, never in a component body. Server " +
    "data → a hook using react-query over the generated api-client (NEVER raw `fetch` — " +
    "see data-fetching) that narrows the response. A hooks file " +
    "exporting too many hooks splits into focused modules (e.g. `*.queries.ts` + " +
    "`*.mutations.ts`).",
  "no-casts":
    "NO CASTS (boringstack). Never write `x as T` or `x!`. To narrow a value (e.g. a " +
    "`<select>` string to a union), use a TYPE GUARD: keep the allowed values in a " +
    "const map (`as const` IS allowed) and guard with `in` — " +
    "`const S = {open:1,closed:1} as const; type St = keyof typeof S; " +
    "function isSt(v:string): v is St { return v in S; }` then `if (isSt(v)) {…}`. " +
    "For a possibly-null DOM/query result, guard with `if (x === null) return` or " +
    "`instanceof`, never `!`.",
  routing:
    "ROUTING (boringstack). A route file is THIN: it imports its feature page and " +
    "renders it — NO UI or logic of its own. Register the feature's page in the SPA " +
    "router (`src/app/router/routes.tsx`) pointing at `@/features/<feature>` — never " +
    "hand-write a component's body in a route file.",
  forms:
    "FORMS (boringstack). Use react-hook-form's `useForm<T>({ resolver: zodResolver(schema) })` " +
    "(from `react-hook-form` + `@hookform/resolvers/zod`) inside `<Component>.hooks.ts`, not the " +
    "component body. Submit via the returned `handleSubmit(onSubmit)` — do NOT hand-type the " +
    "submit handler with React's `FormEvent` (it's the wrong type here and a repeatedly-invented " +
    "error); if you must name the event it is a `BaseSyntheticEvent`, and fire it as " +
    "`void handleSubmit(onSubmit)(event)` (the `void` satisfies no-floating-promises). In the Zod " +
    "schema use the TOP-LEVEL validators — `z.email()`, `z.url()`, `z.uuid()` — NOT the deprecated " +
    "`z.string().email()`. RESOLVER TYPES: do NOT put `.optional()`/`.default()` on a form field's " +
    "schema — it makes the Zod INPUT type differ from the OUTPUT type, so `zodResolver` yields a " +
    "`Resolver<In, any, Out>` that won't match `useForm`/`SubmitHandler` (a persistent 'Resolver … " +
    "not assignable' / 'not assignable to SubmitHandler' error). Keep every field required in the " +
    "schema and supply its initial value in `useForm({ defaultValues })`; type the hook as " +
    "`useForm<z.infer<typeof schema>>` so onSubmit's input matches `SubmitHandler`. Map " +
    "server/validation errors back onto the fields (`setError`); keep " +
    "the component rendering the field state the hook returns.",
  "data-fetching":
    "DATA-FETCHING (boringstack). ALL HTTP goes through the generated client " +
    "`@/lib/api/client` — never `fetch`/`axios` (lint-banned). PATH STRINGS are the #1 thing " +
    "the model gets wrong: the path is a LITERAL that must exactly match a key in the generated " +
    "`paths` type, and every route is mounted under `/api/v1/` — so it is " +
    '`apiClient.GET("/api/v1/<resource>/")`, NOT `"/<resource>"` or `"/api/<resource>"` (a wrong ' +
    "string is a `PathsWithMethod`/'not assignable' error that `generate:api` will NEVER fix — it " +
    "is a usage bug, not a stale-spec bug). TRAILING SLASH matters and is the #1 cause of a POST/GET " +
    "`PathsWithMethod` on a path that otherwise looks right: the COLLECTION root carries a trailing " +
    'slash — list is `GET "/api/v1/<resource>/"` and create is `POST "/api/v1/<resource>/"` (Elysia ' +
    "mounts the group at `/api/v1/<resource>` and the handler at `/`, so the generated key is " +
    '`/api/v1/<resource>/`). The by-id path has NO trailing slash: `"/api/v1/<resource>/{id}"` — use ' +
    "the LITERAL `{id}` segment and pass the value via params, never string-interpolate the id. If a " +
    "POST to `/api/v1/<resource>` (no slash) is rejected, ADD the trailing slash. CALL SHAPE: the " +
    "options object is OPTIONAL — a plain list GET is one arg (`GET(path)`); when you need params " +
    "and/or a body they ALL go together in ONE options object as the SECOND arg — there is NEVER a " +
    "third positional argument:\n" +
    '• list:   `const { data } = await apiClient.GET("/api/v1/supplier/")`  (collection → TRAILING SLASH)\n' +
    '• by id:  `const { data } = await apiClient.GET("/api/v1/supplier/{id}", { params: { path: { id } } })`\n' +
    '• query:  `await apiClient.GET("/api/v1/supplier/", { params: { query: { status: "active" } } })`\n' +
    '• create: `const { data } = await apiClient.POST("/api/v1/supplier/", { body: input })`  (collection → TRAILING SLASH)\n' +
    '• update: `const { data } = await apiClient.PATCH("/api/v1/supplier/{id}", { params: { path: { id } }, body: input })`\n' +
    '• delete: `await apiClient.DELETE("/api/v1/supplier/{id}", { params: { path: { id } } })`\n' +
    "PATCH/PUT take path AND body in the SAME options object (one object as the second arg — " +
    "passing body as a THIRD argument is an arity error: 'Expected 2 arguments, but got 3'). Errors THROW automatically via the " +
    "client's `throwOnError` middleware (TanStack Query catches them) — so NEVER check " +
    "`response.error`: it is typed `undefined`, so the guard is a dead `no-unnecessary-condition` " +
    "gate error. `data` is typed `Readable<SuccessResponse<…>>` (a read-only type helper, NOT a " +
    "stream) for EVERY route — Elysia's swagger emits three media types (json/multipart/text) so " +
    "openapi-fetch unions them. This is EXPECTED and UNIVERSAL (the scaffold's own auth/dashboard " +
    "routes are identical); you CANNOT remove it from the route/response schema, so do NOT try. FIX " +
    "IT ON THE CONSUMER by INFERRING, not annotating. The error appears two ways, BOTH fixed by " +
    "removing a type annotation so TS infers from the unwrapped payload (never `as`-cast): " +
    "(a) `Readable<…> not assignable to Promise<IEntity>` — you annotated the query/mutation fn " +
    "`: Promise<IEntity>` and did a bare `return data`; (b) `UseMutationResult<Readable<…>> not " +
    "assignable to UseMutationResult<IEntity>` (or `UseQueryResult<…>`) — you annotated the HOOK's " +
    "generic/return type (`useMutation<IEntity>` / `: UseMutationResult<IEntity>`). Do NEITHER: " +
    "leave the fn AND the hook UN-annotated and let TS INFER both. " +
    "Then return the payload for YOUR route's response SHAPE: if the response wraps `{ data: … }` " +
    '(the scaffold auth pattern), read `data?.data` — `const { data } = await apiClient.GET("/api/v1/' +
    'supplier/"); return data?.data ?? [];`; if the route returns the object/array DIRECTLY (no ' +
    "`data` envelope), just `return data` — match what your `response:` schema actually declares, " +
    "don't blindly add `.data`. Put " +
    "queries in `<Feature>.queries.ts` and mutations in " +
    "`<Feature>.mutations.ts`. If a path genuinely isn't in the spec yet, add the API route first, " +
    "then `bun run generate:api` ONCE — if the error persists after one regen, the path STRING or " +
    "call shape is wrong, not the spec.",
  "lint-gotchas":
    "STRICT-LINT GOTCHAS (boringstack). The gate is eslint with EVERY rule an error; a fresh " +
    "feature trips these most, so write them right up front:\n" +
    "• AWAIT the promises you use — an un-awaited async call is a no-floating-promises error; " +
    "write `await doX()` (or `void doX()` to deliberately fire-and-forget).\n" +
    "• …but do NOT await non-promises — `await` on a plain value or a sync function's result is " +
    "an await-thenable error; drop the `await`.\n" +
    "• NO value out of a void expression — never `return foo.forEach(...)` or " +
    "`const x = setState(v)`; call the void thing, then return/act separately. For handlers use " +
    "a BLOCK body: `onClick={() => { setOpen(true); }}`, not `() => setOpen(true)`.\n" +
    "• NEVER stringify an error into a log — pass the error object: " +
    '`log.error({ err }, "failed")`, never `` log.error(`${err}`) `` or `String(err)`.\n' +
    "• HOIST heavily-repeated string literals — the same literal 5+ times is a no-duplicate-string " +
    "error; pull it into a `const` (or `<Feature>.constants.ts`) and reference that.",
  testing:
    "TESTING (boringstack). Every logic file needs a co-located test (test-sibling-required), " +
    "and tests are where builds waste the MOST turns — because the model guesses the idioms. " +
    "Write them right the first time:\n" +
    "• EXTENSION — pick ONE, never both: `.test.tsx` ONLY if the test renders JSX (`renderHook` " +
    "with a wrapper, `render`, any `<X/>`); `.test.ts` for pure logic (schemas, utils, services, " +
    "API route tests). The sibling check accepts EITHER, so if you create both, the unused twin " +
    "becomes a knip `unused file` error. A `<X>` inside a `.test.ts` parses as a generic and fails " +
    "with `'>' expected` — that means the file must be `.test.tsx`.\n" +
    "• UI query/mutation/hook tests (`.test.tsx`) — mock the api-client HOISTED at the top, exactly " +
    "this shape:\n" +
    "    const apiMock = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() }));\n" +
    '    vi.mock("@/lib/api/client", () => ({ apiClient: apiMock }));\n' +
    "  Return a CONCRETE typed object from the mock — `apiMock.POST.mockResolvedValueOnce({ data: { " +
    "...the real response shape... } })`. A concrete literal keeps `data` typed; a bare `vi.fn()` " +
    "return is `any`, which then trips no-unsafe/no-unnecessary-condition in the code under test " +
    "(do NOT try to fix that by casting or changing production code). Use `mockResolvedValueOnce` " +
    "per call; use `mockResolvedValue` only for a call that retries (e.g. a GET-me loop). RESET the " +
    "mocks between tests — `beforeEach(() => { apiMock.GET.mockReset(); apiMock.POST.mockReset(); … })` " +
    "(or `vi.resetAllMocks()`; NOT `vi.clearAllMocks()`, which clears only call history and leaves " +
    "queued return values in place) — or a leftover `mockResolvedValue` leaks into the next test (it " +
    "passes alone but fails in the suite). Wrap the " +
    "hook in a `QueryClient` with `retry:false` via `renderHook(() => useX(), { wrapper })` and " +
    "assert with `await waitFor(() => …)`. Imports: `vitest` (`describe, it, expect, vi, beforeEach`) " +
    "+ `@testing-library/react` (`renderHook, waitFor, act`) + `@tanstack/react-query`.\n" +
    "• API tests (apps/api) run under `bun:test`, NOT vitest — `import { describe, expect, test } " +
    'from "bun:test"` (vitest + `vi.*` are UI-only; using them in an apps/api test fails to resolve). ' +
    "For a `*.service.ts` whose function hits the DB (Drizzle), do NOT unit-test it in isolation — you'll " +
    "fight `string | SQLWrapper` types and need a live DB. Its behaviour is covered by the route test " +
    "below; the `*.service.test.ts` only needs to satisfy the test-sibling floor with a minimal smoke " +
    'test (e.g. `expect(typeof myServiceFn).toBe("function")`). Put the real assertions in the route test.\n' +
    "• API route tests (`apps/api/tests/**/*.routes.test.ts`, pure `.ts`) — handle the app in-process, " +
    "never a real network (no-real-network-in-unit-tests):\n" +
    '    const app = createApp(); // from "../../../src/config/app"\n' +
    '    const res = await app.handle(new Request("http://localhost/api/v1/<path>", { method, headers, body }));\n' +
    "    expect(res.status).toBe(200);\n" +
    "  Read the body as `unknown` then TYPE-GUARD it (`const isX = (v: unknown): v is {…} => …; if " +
    "(!isX(body)) throw new Error(…)`) — never `as`. For an authed route, define a local `loginCookie` " +
    "helper (copy it verbatim from an existing `*.routes.test.ts`) and pass the returned cookie in headers.\n" +
    "• RULES the gate enforces: no `.only`/`.skip` (no-focused-tests); never put `expect` inside an " +
    "`if`/loop/`switch`/ternary — assert unconditionally (no-conditional-expect); if you use fake " +
    "timers, restore them in `afterEach` (fake-timers-must-be-restored); the test path/name mirrors " +
    "its source (test-file-mirrors-source). A no-op/placeholder callback (e.g. an unused handler " +
    "arg when testing ONE of a hook's callbacks) must be `vi.fn()`, NEVER an empty `() => {}` — an " +
    "empty arrow/function body is a `no-empty-function` gate error (observed: 9 in one row-hook test).\n" +
    "• After you write a test the harness AUTO-FORMATS it (imports reordered, quotes/commas normalized), " +
    "so your next `edit` oldString won't match — RE-READ the file and copy oldString from its current " +
    "content; do NOT recreate the whole file.",
  "api-service":
    "API SERVICE (boringstack). apps/api resource logic lives in `<entity>.service.ts`. Every " +
    "MUTATING method (create/update/delete) MUST record an audit event — the gate rejects one that " +
    "doesn't (`Mutating method '…' does not record an audit event`). Import `{ AUDIT_ACTIONS, " +
    'auditLogService } from "../../lib/audit-log"` and, after the mutation, call ' +
    "`void auditLogService.record({ userId, action: AUDIT_ACTIONS.<ENTITY_ACTION>, metadata: { … } })` " +
    "(the `void` satisfies no-floating-promises). Read-only methods (get/list) don't need it. Surface " +
    "failures by THROWING an `ApiError` (e.g. 404/409), not by returning an error envelope — the route " +
    "layer maps thrown ApiErrors to responses. Every ROUTE should declare a `response:` schema " +
    "(`.get(path, handler, { response: <Entity>ResponseSchema })`) so the body TYPE is generated — " +
    "define it like the scaffold's `AccountResponse` (a plain `t.Object({…})`, NO `headers`). NOTE: a " +
    "`response:` schema does NOT collapse the media types — Elysia's swagger always emits " +
    "json+multipart+text, so the UI's `data` is ALWAYS `Readable<SuccessResponse<…>>` (true for the " +
    "scaffold's own routes too). That is NORMAL and is handled on the CONSUMER via `data?.data` (see " +
    "data-fetching), NOT by changing this route — do not chase it from the API side.",
  i18n:
    "I18N LOCALE KEYS (boringstack). Every user-facing string is a translation key, and the gate " +
    'enforces BOTH directions: a `t("key")` with no locale entry fails (used→defined), AND a key ' +
    "defined in the locale files that NO src file references fails as 'dead translation surface' " +
    "(i18n-locale-keys-used, defined→used). THE TRAP that stalls near-green builds is PRE-DECLARING " +
    "keys: never add a key to the locale JSON 'for later' or in a batch. Add a key and its single " +
    '`t("full.dotted.path")` reference in the SAME change — if you are not calling `t()` on it right ' +
    'now, do not define it. WIRING: `import { useTranslation } from "react-i18next"`, then ' +
    "`const { t } = useTranslation()` in the component (a hook — it lives in the component body per " +
    'react-hooks rules, NOT in `.hooks.ts`), and `t("features.<feature>.<key>")` in the JSX. The ' +
    "reference must ALWAYS be the FULL dotted key as a plain STRING LITERAL — never assemble a key by " +
    "concatenation or a template (`t(`…${x}`)`): the used→defined check (static-translation-key-exists) " +
    "only reads string literals, so a dynamic key silently BYPASSES validation and ships missing " +
    "translations. If a value varies (e.g. a status label), map each concrete case to its own literal " +
    "key. LOCALE FILES: add the key to EVERY locale — `src/lib/i18n/locales/en/common.json` (the " +
    "canonical file the rule scans) AND `src/lib/i18n/locales/de/common.json` — nested under the dotted " +
    "path. FIXING a dead-key (i18n-locale-keys-used) error: WIRE IT UP — add the missing " +
    '`t("features.<feature>.<key>")` in the component that should display it. This clears by ADDING code, ' +
    "not removing it. Do NOT delete a key you authored this session to silence the rule: it strips real " +
    "functionality the feature needs (a hollow list-only page), it's pure churn you'll re-add, and the " +
    "build's i18n edit-guard VETOES a net deletion of session-authored keys anyway. (Removal is only for " +
    "a genuinely obsolete pre-existing key, or a balanced rename that adds the replacement in the same edit.)",
  "design-tokens":
    "DESIGN TOKENS (boringstack). NEVER hardcode a color — no hex/rgb, no named colors, no arbitrary " +
    "`bg-[#…]`. Every color is a CSS-variable design token exposed as a BARE Tailwind class; pick the " +
    "token whose ROLE matches: `bg-background`/`text-foreground` (page), `bg-card`/`bg-panel` " +
    "(containers/surfaces), `text-muted-foreground` (secondary/de-emphasized text), `border-border` and " +
    "`border-border-strong/40` (dividers — the `/40` opacity variant for subtlety), " +
    "`bg-primary text-primary-ink hover:bg-primary-strong` (primary CTA), `bg-secondary`/`bg-accent` " +
    "(secondary / highlight), `bg-destructive text-destructive-foreground` (delete/danger), `text-success` " +
    "(success), `ring-ring` (focus ring), `rounded-md`/`rounded-xl` (the `--radius` scale), `font-sans` " +
    "(Inter — the default) / `font-mono`. Spacing/sizing use the normal Tailwind scale. A raw color value " +
    "is a design-system violation — there is a token for every role.",
  theming:
    "THEMING (boringstack). Light/dark is DATA-ATTRIBUTE driven: tokens flip on " +
    '`<html data-theme="dark">`, so a token class (`bg-background`, `text-foreground`, `bg-card`) is ' +
    "AUTOMATICALLY correct in BOTH themes. NEVER write a `dark:` Tailwind variant (`dark:bg-…`) — it is " +
    "banned (AGENT_CONTRACT) and redundant; the token already switches. Do not read or set the theme " +
    "yourself — the `useTheme()` hook + the existing ThemeToggle own it. To test both themes, toggle " +
    '`document.documentElement.setAttribute("data-theme", "dark")` and assert token-classed elements ' +
    "still render; never assert a literal color value.",
  responsive:
    "RESPONSIVE (boringstack). Mobile-first: an UNPREFIXED class is the MOBILE style; add `sm:`/`md:`/`lg:` " +
    "for larger screens (`px-4 lg:px-6`, `grid-cols-1 md:grid-cols-2`, `flex-col md:flex-row`). `md:` is the " +
    "primary layout breakpoint. Every page MUST be usable at 375px wide — never fix a px width that " +
    "overflows small screens; use `w-full`/`max-w-*` + breakpoint prefixes. NAV pattern: the sidebar is " +
    '`hidden md:flex` on desktop with a `Sheet` drawer (`@/components/ui/sheet`, `side="left"`) for mobile ' +
    "— REUSE that, don't invent a nav. For layout INSIDE a component, container queries (`@container`) are " +
    "available (see the Card header).",
  accessibility:
    "ACCESSIBILITY (boringstack). The gate runs `eslint-plugin-jsx-a11y` as ERRORS — satisfy it on the " +
    "first draft, don't discover it at the gate. An icon-only button needs an `aria-label`; a DECORATIVE " +
    'icon (lucide) needs `aria-hidden="true"`; screen-reader-only text is `className="sr-only"`; every ' +
    "heading/anchor must have content; a `<label>` must link its control (`htmlFor`+`id`, or use the " +
    "`Label`+`Form` primitives). NEVER attach `onClick` to a `<div>`/`<span>` (no-static-element-" +
    'interactions / click-events-have-key-events) — use `<button type="button">` or the `Button` ' +
    "primitive so keyboard + focus come for free. STRUCTURE with semantic landmarks — `<nav aria-label=…>`, " +
    '`<main>`, `<header>`, `<section>` — and mark the active nav link `aria-current="page"`. Prefer Radix ' +
    "primitives (Dialog/Tabs/DropdownMenu/Switch) over hand-rolled widgets: they ship focus-trap, roles, " +
    "and keyboard handling already.",
  "components-ui":
    "COMPONENTS (boringstack). Prefer the ready primitives in `@/components/ui/` — Button, Input, Label, " +
    "Form (react-hook-form), Card (+Header/Title/Content/Footer), Dialog, Sheet, DropdownMenu, Popover, " +
    "Tabs, Switch, ScrollArea, Skeleton, Sonner (toast) — over hand-built markup: they are already " +
    "accessible (Radix) and themed (tokens). Compose classNames with the `cn()` helper (tailwind-merge + " +
    "clsx) — NEVER string-concatenate or ternary a className. Add a VARIANT to a primitive via its `cva` " +
    "config; do not fork it. `asChild` renders a primitive AS another element (e.g. `<Button asChild>` " +
    "wrapping a router `Link`). These `src/components/ui/` primitives are EXEMPT from component-anatomy — " +
    "import them, never recreate them under a feature.",
};

/** The guide for a topic (the exact string pushed or pulled). */
export function conventionGuide(topic: ConventionTopic): string {
  return GUIDES[topic];
}

/** Every topic name — for the pull tool's enum + listings. */
export function conventionTopics(): ConventionTopic[] {
  return [...TOPICS];
}

/** The full PUSH body of every stack convention GUIDE (not just a topic index), joined for the
 *  build system prompt (WS-A1). Front-loading the actual compliant patterns — the exact shape
 *  for components, state, JSX, casts, data-fetching, etc. — lets the model write it right on the
 *  FIRST draft instead of guessing from memory and burning turns at the gate. The reactive PUSH
 *  (`unseenGuidesForErrors`) and `pull_conventions` remain fallbacks for reinforcement and the
 *  long tail, not the primary teaching. */
export function buildConventionGuides(): string {
  return [
    "HOW THIS STACK WRITES CODE — read this BEFORE you write, not after the gate rejects you. These are the exact compliant patterns the gate enforces; write your FIRST draft this way instead of guessing from memory and burning turns repairing. (`pull_conventions` re-fetches any of these on demand.)",
    "",
    ...conventionTopics().map((t) => conventionGuide(t)),
  ].join("\n\n");
}

/** Narrow an arbitrary string to a ConventionTopic (for the pull tool's arg) —
 *  membership test, no `as` cast. */
export function isConventionTopic(s: string): s is ConventionTopic {
  return TOPIC_SET.has(s);
}

/** The topic whose enforced rules include `rule` (bare or plugin-prefixed), or null.
 *  Lets a gate error cross-reference the guide that prevents it. */
export function topicForRule(rule: string): ConventionTopic | null {
  const bare = rule.split("/").pop() ?? rule;

  for (const topic of conventionTopics()) {
    if (TOPIC_RULES[topic].includes(bare)) {
      return topic;
    }
  }

  return null;
}

/**
 * PUSH helper: the convention guides for the gate errors whose rule maps to a topic
 * NOT already shown this run (`seen` is mutated to dedupe). This is how the loop
 * hands the model the boringstack how-to the FIRST time it trips a rule — right
 * beside the error, not after the steering ladder escalates. One guide per topic
 * per run: enough to teach, not a wall.
 */
export function unseenGuidesForErrors(
  errors: readonly { readonly rule?: string }[],
  seen: Set<string>
): string[] {
  const out: string[] = [];

  for (const e of errors) {
    if (e.rule === undefined) {
      continue;
    }

    const topic = topicForRule(e.rule);

    if (topic === null || seen.has(topic)) {
      continue;
    }

    seen.add(topic);
    out.push(conventionGuide(topic));
  }

  return out;
}

/**
 * The BoringStack front-loaded guides packaged as the generic `IConventionProvider`
 * seam. The core session's system prompt depends on the INTERFACE (injected via
 * `ISessionConfig.conventions`); this concrete provider — the BoringStack CONTENT —
 * is supplied by the boringstack adapter (`build-config.ts`), so the session no longer
 * imports `buildConventionGuides` directly. (WS1a scope: the reactive push + the
 * `pull_conventions` tool still import this module directly — they migrate to the
 * provider, and this module relocates into `loop/boringstack/`, in WS1b.)
 */
export const boringstackConventionProvider: IConventionProvider = {
  buildGuides: buildConventionGuides,
  unseenForErrors: unseenGuidesForErrors,
  guide: (topic) => (isConventionTopic(topic) ? conventionGuide(topic) : null),
  topics: conventionTopics,
  isTopic: isConventionTopic,
};
