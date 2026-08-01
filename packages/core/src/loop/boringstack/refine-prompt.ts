import type { IFeature } from "../greenfield/greenfield.types";
import type { ISlice } from "../planning/plan-types";
import type { IUiIntent } from "./plan-extension";
import { toCamelCase } from "./case";

/** Per-slice layout wiring: where the feature's nav link goes (primary app group vs a demoted
 *  Settings group) and, if it's the app home, the post-login redirect. v1 implements app-sidebar
 *  + settings; the other archetypes build as app-sidebar for now (the enum is broad on purpose). */
function layoutGuidance(slice: ISlice<IUiIntent>): string {
  const layout = slice.ui.layout ?? "app-sidebar";
  const route = `/${toCamelCase(slice.entity.id)}`;
  const lines: string[] = [];

  // Plan validation only admits the IMPLEMENTED archetypes (app-sidebar | settings), so those are
  // the only values that reach here; anything else is treated as the app-sidebar default.
  if (layout === "settings") {
    lines.push(
      "**Layout**: `settings` — a DEMOTED config area. Add this feature's sidebar link to a " +
        "secondary **Settings** group in `AppSidebar` (grouped with the account/profile/settings " +
        "links, below the primary app nav), NOT the primary app nav group."
    );
  } else {
    lines.push(
      "**Layout**: `app-sidebar` — a PRIMARY app view. Add its sidebar link to the primary app " +
        "nav group at the TOP of `AppSidebar`, above the Settings/account links."
    );
  }

  if (slice.ui.home === true) {
    lines.push(
      "**Home**: this feature is the app's landing view — the harness AUTOMATICALLY points the " +
        `post-login redirect (\`DEFAULT_REDIRECT_TO\`) at its route (\`${route}\`). Do NOT edit ` +
        "the login page or that constant yourself; just build this feature well as the primary " +
        "app view the user lands in."
    );
  }

  return lines.join("\n\n");
}

function productContextSection(slice: ISlice<IUiIntent>): string {
  const fieldsList = slice.entity.fields
    .map((f) => {
      const optionalMarker = f.optional === true ? " [optional]" : "";

      return `- \`${f.name}\` (${f.type})${optionalMarker}`;
    })
    .join("\n");

  const relationshipsList = slice.entity.relationships
    .map((r) => `- ${r}`)
    .join("\n");

  const rulesList = slice.entity.rules.map((r) => `- ${r}`).join("\n");

  const screensList = slice.ui.screens.join(", ");

  const showsList = slice.ui.shows.join(", ");

  const mustRemainList = slice.verification.mustRemainTrue
    .map((m) => `- ${m}`)
    .join("\n");

  const mustNotList = slice.verification.mustNotHappen
    .map((m) => `- ${m}`)
    .join("\n");

  return `## Product Context

### Entity: ${slice.entity.id}

**Fields**:
${fieldsList}

**Relationships**:
${relationshipsList}

**Rules**:
${rulesList}

### UI Intent

**Screens**: ${screensList}

**Primary action**: ${slice.ui.action}

**Display**: ${showsList}

**Navigation**: ${slice.ui.nav}

${layoutGuidance(slice)}

### Verification Contract

**Must remain true**:
${mustRemainList}

**Must not happen**:
${mustNotList}

**Acceptance check**: ${slice.verification.acceptanceCheck}`;
}

/**
 * Generate the refine prompt that tells the model which files to fill in
 * for one BoringStack resource.
 *
 * The prompt:
 * - Names the resource and its behaviour
 * - When a slice is provided, includes product context (entity fields, relationships, rules, UI intent, verification contract)
 * - Lists the exact generated files the model must fill
 * - Requires test siblings to be written
 * - Includes domain-fill instructions (real fields, real logic, no `as` casts)
 * - States the FREEZE: only this resource's files are editable
 */
export function refinePrompt(
  feature: IFeature,
  slice?: ISlice<IUiIntent>
): string {
  const camel = toCamelCase(feature.id);

  // On a retry, lead with the ACTUAL gate/judge errors from the last attempt so the
  // model fixes those specific failures instead of rebuilding blind.
  const priorFailure =
    feature.lastError === undefined || feature.lastError.trim().length === 0
      ? ""
      : `\n\n## ⚠️ Your PREVIOUS attempt FAILED the gate — FIX THESE ERRORS FIRST\n\nThe build gate (typecheck / lint / tests / OpenAPI drift) reported:\n\n\`\`\`\n${feature.lastError}\n\`\`\`\n\nAddress every error above before anything else. The same gate must pass this time.\n\n---`;

  const productContext = slice ? `\n\n${productContextSection(slice)}\n` : "";

  // Where the model reads the resource's PERSISTED/EDITABLE domain fields from — the
  // columns to store and the form inputs to render. This is the entity's **Fields**
  // ONLY: **Display** is a rendering hint (may be computed values, relationship
  // labels, or a read-only subset) and must NOT be turned into columns or inputs.
  // With a slice the Product Context section is present; without one, fall back to
  // the behavior so no instruction dangles a reference to a section that wasn't emitted.
  const domainFields = slice
    ? "the entity's **Fields** in Product Context above (the **Display** list is for rendering only — do NOT treat it as columns or form inputs)"
    : `the fields implied by the behavior "${feature.desc}"`;

  return `You are implementing the **${feature.id}** resource.

**Behavior**: ${feature.desc}${priorFailure}${productContext}

---

## Files to Implement

You MUST fill in these generated files for the **${feature.id}** resource:

### Persistence (apps/api/src/clients/postgres/schema/app.schema.ts)
- The \`${camel}\` Drizzle table is generated with only stub columns (\`id\`, \`userId\`, \`name\`, timestamps). **Add the real domain columns to it** — one column per ${domainFields} (choose the right Drizzle type: \`varchar\`/\`text\` for strings, \`boolean().notNull().default(false)\` for booleans, \`integer\`/\`numeric\` for numbers, \`timestamp\` for dates; make \`[optional]\` fields nullable). These columns are what actually persists — the service and types must read/write REAL columns, never in-memory-only fields.
- **Import every column builder you use.** If you add a \`boolean\`/\`text\`/\`integer\`/\`numeric\`/\`jsonb\` column, that identifier MUST be added to the existing \`import { ... } from "drizzle-orm/pg-core"\` line at the top of the file. A missing import is a \`ReferenceError\` that crashes the API on boot — the #1 cause of a failed build here.
- Edit ONLY the \`${camel}\` table. Do NOT touch any other table in this file.

### API Layer (apps/api/src/api/${camel}/)
The UI needs FULL CRUD, so the API must expose it. The scaffold ships only list+create — you MUST add get-one, update, and delete so the UI's edit/delete have real endpoints (missing routes surface as typed api-client failures after \`generate:api\`).
- \`apps/api/src/api/${camel}/${camel}.routes.ts\` — Elysia routes for the full set: **list (\`GET /\`), get-one (\`GET /:id\`), create (\`POST /\`), update (\`PATCH /:id\`), delete (\`DELETE /:id\`)**. Every route stays under \`requireAuth()\` and passes \`user.id\` to the service on EVERY call. A schema on EVERY route; \`ApiErrors.*\` (never \`throw new Error\`).
- \`apps/api/src/api/${camel}/${camel}.service.ts\` — a user-scoped method backing each route, EXTENDING the scaffold's existing \`listForUser(userId)\` + \`create({ …, userId })\` convention (do NOT rename them — that breaks the baseline): add \`getForUser(id, userId)\`, \`updateForUser(id, userId, data)\`, \`deleteForUser(id, userId)\`. Real Drizzle ops, not stubs.
  - **SECURITY (critical): every get/update/delete MUST filter by BOTH the row id AND the authenticated \`userId\`** — \`where: and(eq(${camel}.id, id), eq(${camel}.userId, userId))\` (import \`and\` and \`eq\` from \`drizzle-orm\` — a missing import is the same boot-crashing ReferenceError as a missing column builder). A row is owned by one user; an id-only query lets one user read, modify, or delete another user's records (horizontal privilege escalation). Never look up or mutate a row by id alone.
- \`apps/api/src/api/${camel}/${camel}.schemas.ts\` — request/response validation schemas for each operation (create body, update body, item response) using **Elysia TypeBox** (\`import { t } from "elysia"\` → \`t.Object({ title: t.String(), … })\`). This is the API boundary — do NOT use Zod here; Zod is only for UI form/runtime validation.
- \`apps/api/src/api/${camel}/${camel}.types.ts\` — TypeScript types for domain entities and DTO objects

### UI Feature (apps/ui/src/features/${camel}/)
The generated feature is a HOLLOW starting point — a list-only page plus STUB hooks (\`use${feature.id}\` returns \`[]\`, \`useCreate${feature.id}\` just returns its input). A page that only lists records (or only shows an empty state) is an INCOMPLETE feature and must not be shipped. Build the REAL CRUD UI:
- **Mutations** (\`${feature.id}.mutations.ts\` — PascalCase file in \`apps/ui/src/features/${camel}/\`): implement real \`useCreate${feature.id}\`, \`useUpdate${feature.id}\`, and \`useDelete${feature.id}\` — each calls \`@/lib/api/client\` (\`apiClient.POST/PATCH/DELETE\`). **The client's \`throwOnError\` middleware THROWS an \`ApiError\` on any non-2xx — it does NOT return an error to check.** So \`error\` is typed \`undefined\`: writing \`if (error) throw error\` is a DEAD \`no-unnecessary-condition\` (error can't be truthy) AND \`only-throw-error\` (you'd be throwing \`undefined\`). React Query catches the thrown ApiError, so invalidate the list query in \`onSuccess\` and surface failures in \`onError\` — never guard \`error\`. Do NOT leave the stub that returns its input. **Match each hook's annotation AND its \`data\` handling to what its route RETURNS** (this is the scaffold's exact idiom — see \`features/accounts/JoinRequests.mutations.ts\`):
  - **create / update** return the affected item, so the API route declares \`response: <ItemSchema>\` and the hook is \`export function useCreate${feature.id}(): UseMutationResult<I${feature.id}Item, unknown, ${feature.id}CreateInput> { … }\` (1st generic = returned item type, 2nd = \`unknown\`, 3rd = the input variables). The client always types \`data\` as OPTIONAL (\`I${feature.id}Item | undefined\`), so \`return data\` does NOT typecheck against \`I${feature.id}Item\` — **GUARD, then return** (the guard narrows out \`undefined\`): \`const { data } = await apiClient.POST(…, { body: input }); if (!data) throw new ApiError(0, { message: "Empty create response" }); return data;\`. (If YOUR \`response:\` schema wraps the item as \`{ data: … }\`, read \`if (!data?.data) throw …; return data.data;\` — match your schema, don't blindly add \`.data\`.)
  - **delete** returns nothing, so the API route declares \`response: t.Null()\` and the hook is \`export function useDelete${feature.id}(): UseMutationResult<void, unknown, string> { … }\` (returned type = \`void\`, variables = the id string) — just \`await apiClient.DELETE("/api/v1/${camel}/{id}", { params: { path: { id } } });\` and return nothing. Do NOT annotate a delete with \`UseMutationResult<I${feature.id}Item, …>\`; a \`t.Null()\` route can't yield an item and it won't typecheck.
  Same split as the query: \`Type 'Readable<SuccessResponse<...>>' is not assignable\` (printed abbreviated) means \`data\` did NOT resolve to \`I${feature.id}Item\` — fix it UPSTREAM (this route's \`response:\` schema must match the service return, and the path/verb must be right; the gate re-runs \`generate:api\`), NOT by \`as\`/guard/unwrap tricks that can't convert the wrapper. Once \`data\` resolves, unwrap to match THIS route's own \`response:\` shape you declared above — a direct \`response: <ItemSchema>\` route guards then \`return data\`; only an enveloped \`response: t.Object({ data: <Item> })\` route reads \`return data.data\` (keep route + consumer consistent — do not mix). A plain \`I${feature.id}Item | undefined\` "not assignable to \`I${feature.id}Item\`" = \`data\` resolved but is optional — that's what the GUARD-then-return above fixes. Never \`as\`-cast it, never "remove the annotation and let TS infer", and never annotate a hook with \`Readable<SuccessResponse<…>>\`.
  (Use the REAL domain fields of ${feature.id} — ${domainFields} — NOT a single placeholder \`name\`.)
- **List query** (\`${feature.id}.queries.ts\` — PascalCase file): implement \`use${feature.id}\` to actually fetch via \`apiClient.GET\` (the scaffold stub returns \`[]\`, so the list is permanently empty and create→appears-in-list is impossible until you do this). **ANNOTATE the hook + queryFn return with your DOMAIN item type** to state the hook's contract, exactly as the scaffold's green hooks do. (When the route's \`response:\` schema is correct, \`data\` resolves to \`I${feature.id}Item[] | undefined\` and \`return data ?? []\` compiles. If you instead see \`Readable<SuccessResponse<...>>\`, \`data\` didn't resolve — fix the route's \`response:\` schema/path upstream, per the note under the snippet; \`?? []\`/\`as\` can't convert the wrapper. Never \`as\`, never drop the annotation.) Copy the scaffold's exact shape (see \`features/accounts/JoinRequests.queries.ts\`):
\`\`\`ts
export function use${feature.id}(): UseQueryResult<I${feature.id}Item[]> {
  return useQuery({
    queryKey: ${camel.toUpperCase()}_QUERY_KEYS.list,
    queryFn: async (): Promise<I${feature.id}Item[]> => {
      const { data } = await apiClient.GET("/api/v1/${camel}/");
      return data ?? [];
    },
  });
}
\`\`\`
The explicit \`UseQueryResult<I${feature.id}Item[]>\` + \`Promise<I${feature.id}Item[]>\` state the hook's contract and match the scaffold's green shape. After \`const { data } = await apiClient.GET(…)\`, \`data\`'s type is whatever \`generate:api\` produced for this path — in the green scaffold it IS \`I${feature.id}Item[] | undefined\`, so \`return data ?? []\` compiles. **Two DIFFERENT errors, two DIFFERENT fixes — do not confuse them:** (a) \`Type 'Readable<SuccessResponse<...>>' is not assignable to type 'I${feature.id}Item[]'\` (tsc prints the abbreviated \`<...>\`) means \`data\` did NOT resolve to your item type — an UPSTREAM problem, not a consumer one. \`?? []\`, a nullish guard, and \`as\` only touch null/undefined; none converts the wrapper into \`I${feature.id}Item[]\`. Fix upstream so \`data\` resolves: the API route needs a \`response:\` schema matching BOTH the service return and your \`I${feature.id}Item\` shape (list → \`t.Array(<ItemSchema>)\`), and if you just changed that schema the types are stale — the gate re-runs \`generate:api\` next cycle. (A wrong path surfaces separately as \`PathsWithMethod\`, not here.) (b) "\`I${feature.id}Item[] | undefined\` is not assignable to \`I${feature.id}Item[]\`" means \`data\` DID resolve and is just optional — that's the one \`return data ?? []\` fixes; do NOT touch the schema for this one. Do NOT \`as\`-cast and do NOT "remove the annotation and let TS infer". Do NOT check \`error\` (typed \`undefined\`; the \`throwOnError\` middleware throws and React Query catches it).
- **Query keys: USE the generated constant, never an inline array.** The scaffold ALREADY generates \`${camel.toUpperCase()}_QUERY_KEYS\` in \`${feature.id}.constants.ts\` as a static tuple, e.g. \`export const ${camel.toUpperCase()}_QUERY_KEYS = { list: ["${camel}", "list"] as const };\`. A \`useQuery\`/\`useMutation\` \`queryKey\`/\`mutationKey\` that is an INLINE array literal starting with a string (\`queryKey: ["${camel}", id]\`) is REJECTED: "queryKey must be a constant — define it in *.constants.ts". So REFERENCE the generated constant — \`useQuery({ queryKey: ${camel.toUpperCase()}_QUERY_KEYS.list, … })\` (a PROPERTY, exactly as the scaffold wired it) — and invalidate the list in the mutations' \`onSuccess\` with the SAME key (\`queryClient.invalidateQueries({ queryKey: ${camel.toUpperCase()}_QUERY_KEYS.list })\`) so create/edit/delete refresh it. If you need an ADDITIONAL key (e.g. a get-one \`detail\`), ADD it to that constant in the scaffold's style — a static tuple for a fixed key, and a factory ONLY for a parameterized one: \`detail: (id: string) => ["${camel}", id] as const\`, used as \`${camel.toUpperCase()}_QUERY_KEYS.detail(id)\`. Do NOT rewrite the existing static \`list\` tuple into a function — bare \`.list\` usages would then hand React Query a function as the key and silently break list refresh.
- **List**: render the fetched records (not just an empty state) — one row per record showing those domain fields, each row with **Edit** and **Delete** actions.
- **Create/Edit form**: one input per domain field. Validate with Zod; on submit call the create/update mutation; on error render \`t("features.${camel}.<action>Error")\`. **Use Zod v4 TOP-LEVEL format validators, not the deprecated string methods:** a URL is \`z.url(msg)\`, an email is \`z.email(msg)\`, a uuid is \`z.uuid(msg)\` — NOT \`z.string().url(msg)\` / \`z.string().email(msg)\`, which Zod v4 deprecated (\`@typescript-eslint/no-deprecated\`: "\`url\` is deprecated. Use \`z.url()\` instead" — a near-green wall). The scaffold's green schemas use the top-level form (see \`apps/ui/src/features/auth/Auth.schemas.ts\` → \`z.email("…")\`). An OPTIONAL url that also allows an empty string: \`z.url(msg).optional().or(z.literal(""))\`.
- **Delete**: a confirmation using \`t("features.${camel}.confirmDelete")\` that calls \`useDelete${feature.id}\`.
- The UI must carry out the feature's flow end to end (create → it appears in the list → edit → delete). Wiring the mutations into a real form + list is what makes the i18n error/confirm keys "used" — that is the intended way to clear \`i18n-locale-keys-used\`, never by deleting keys.

---

## Required Test Siblings

The linter enforces test coverage — **every logic file you add or change needs a mirrored test sibling**, API and UI alike:

- \`apps/api/tests/api/${camel}/${camel}.routes.test.ts\` — API endpoint tests covering create/update/delete, not just list.
- \`apps/api/tests/api/${camel}/${camel}.service.test.ts\` — Service layer unit tests. **These MUST include an ownership-isolation test that PROVES the userId scoping above:** create a row as user A, then assert user B's \`getForUser\`/\`updateForUser\`/\`deleteForUser\` on that id find/affect NOTHING (returns not-found / 0 rows — the same as a missing id), and that user A still can. Without this test the id-only privilege-escalation bug passes the gate — prose alone does not stop it.
- \`apps/ui/src/features/${camel}/…\` — **vitest**, a co-located mirrored test for every UI logic file you write (mutations/hooks/form). Beyond unit-testing the mutations (mock \`@/lib/api/client\`, assert \`useCreate${feature.id}\`/\`useUpdate${feature.id}\`/\`useDelete${feature.id}\` call it), include a test that RENDERS the feature page and drives the REAL flow through the list: fill the create form and submit (assert the create mutation fires), then trigger a rendered row's **Edit** (assert the update mutation fires) and **Delete** confirmation (assert the delete mutation fires). A test that only checks the hooks call the client — or that exercises create alone — can pass while update/delete stay disconnected from the page and the feature is still hollow; it MUST drive edit and delete from the rendered list.

**UI test async idiom (avoids \`@typescript-eslint/require-await\`).** An \`async\` test or \`act\` callback MUST contain an \`await\`, or the rule fails ("Async arrow function has no 'await' expression") — the dominant near-green churn in generated UI tests. Two shapes:
- **Mutation-hook tests:** \`await\` the mutation INSIDE \`act\` — \`await act(async () => { await result.current.mutateAsync(input); });\` then assert via \`await waitFor(() => expect(…));\` (the scaffold's gate-green shape — see \`apps/ui/src/features/accounts/JoinRequests.mutations.test.tsx\`). Note the deliberate divergence from the component: the component fires \`mutate\` (fire-and-forget, so its handler never rejects), but the TEST uses \`mutateAsync\` + \`await\` so it can synchronize on completion. Do NOT write \`act(async () => { result.current.mutate(input); })\` — the callback has no \`await\`, so \`require-await\` fails.
- **Component render tests:** mark \`it("…", async () => { … })\` async ONLY when the body actually awaits — \`await screen.findByText(…)\` / \`await waitFor(() => …)\` to wait for async-rendered data (also the correct way to assert on data that loads). A purely synchronous \`render\` + \`getByText\`/\`getByRole\` test stays \`() => { … }\` (no \`async\`), or it trips \`require-await\`.

Without these test files, the build will fail.

**Test runner — do NOT mix them:** \`apps/api\` tests use **\`bun:test\`** (\`import { describe, test, expect } from "bun:test"\`). \`apps/ui\` tests use **\`vitest\`** (\`import { describe, it, expect } from "vitest"\`) — a UI test that imports \`bun:test\` fails with "Cannot find module 'bun:test'". Match the runner already used by the sibling test files in that app; never introduce the other one.

---

## BoringStack API conventions — write it RIGHT the first time

**Route tests** (\`${camel}.routes.test.ts\`): test THROUGH the app — NEVER call route handlers directly (that triggers unsatisfiable Elysia handler generic types, a common failure). Use this exact shape:
\`\`\`ts
import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../../../src/config/app";
import { cleanDatabase, requireDb } from "../../helpers/db";

describe("${camel} routes", () => {
  beforeEach(async () => {
    if (await requireDb()) await cleanDatabase();
  });
  test("GET /api/v1/${camel} requires auth", async () => {
    const res = await createApp().handle(
      new Request("http://localhost/api/v1/${camel}")
    );
    expect(res.status).toBe(401);
  });
});
\`\`\`
Go through \`tests/helpers/db\` for db/schema — never import \`drizzle-orm\` or the schema in a test.

**Routes** (\`${camel}.routes.ts\`): a schema on EVERY route; NO per-handler try/catch (Elysia \`.onError\` handles errors centrally); NEVER \`throw new Error\` — throw \`ApiErrors.notFound(...)\` / \`.validation(...)\` / \`.unauthorized(...)\`. Chain \`.get\`/\`.post\`/\`.patch\`/\`.delete\` DIRECTLY on \`requireAuth().onError(...)\` — do NOT wrap them in \`.group("/", …)\` (inside a \`.group\` callback the app has no \`user\` and loses schema inference). \`.group\` is only for mounting a sub-router at a prefix.

**Response schemas + nullable columns (the #1 opaque Elysia error):** a \`response\` schema field must match EXACTLY what the service returns, or Elysia rejects the handler with an inscrutable "not assignable to \`InlineHandlerNonMacro\`" \`TS2345\` on the route (it points at the route, NOT the real mismatch). The trap: a NULLABLE Drizzle column (\`.notNull()\` absent) infers \`string | null\`, but \`t.Optional(t.String())\` is \`string | undefined\` — \`null\` ≠ \`undefined\`. For a nullable column use \`t.Optional(t.Union([t.String(), t.Null()]))\` in the response (or make the column \`.notNull()\`). A \`Date\` column against \`t.String()\` is fine.

**Service** (\`${camel}.service.ts\`): Drizzle + logic; throw \`ApiErrors.*\`; \`catch (err: unknown)\` → \`getErrorMessage(err)\`; singleton export.

**TypeScript (strict-type-checked, all enforced):** no \`any\`, no \`as\` (only \`as const\`), no non-null \`!\`; \`I\`-prefixed interfaces; explicit return types on exported functions; UPPER_CASE top-level constants; no magic string literals in \`===\`/\`switch\` (reference a typed constants object); no inline \`eslint-disable\`.

---

## BoringStack UI component conventions — write it RIGHT the first time

The UI eslint (react-component-architecture) is strict; these rules cause the most churn. Copy the scaffold's gate-green example \`apps/ui/src/features/accounts/components/JoinRequestsPage/JoinRequestsPage.tsx\` — a list with per-row actions, exactly the shape your edit/delete rows need.

**No arrow functions or .bind in JSX props (\`jsx-no-bind\` — the #1 churn source).** \`onClick={() => onEdit(row.id)}\` is REJECTED. For per-row actions add a curried helper in \`${camel}.utils.ts\`:
\`\`\`ts
export const makeIdHandler =
  (fn: (id: string) => void) => (id: string) => () => fn(id);
\`\`\`
then in the component body \`const editHandler = makeIdHandler(onEdit);\` (and \`deleteHandler\`), and in JSX \`onClick={editHandler(row.id)}\`. The prop is a call expression, not a literal arrow, so the rule passes. This curried-helper pattern is the scaffold's own gate-green convention (see JoinRequestsPage example). Do NOT call \`useCallback\` in the component body to stabilise the handler. react-component-architecture forbids React's STATE-PRIMITIVE hooks (\`useState\`/\`useReducer\`/\`useEffect\`/\`useLayoutEffect\`/\`useMemo\`/\`useCallback\`/\`useRef\`) from being called DIRECTLY in a component that returns JSX — those must live inside a custom hook in a co-located \`<Component>.hooks.ts\` (else "must be in a custom hook (.hooks.ts), not in component body"). The body MAY still call other hooks inline: your own custom hook(s) (e.g. \`use${feature.id}Page()\`), \`useTranslation()\`, and \`useId\`/\`useTransition\`/\`useDeferredValue\` are all allowed there — the scaffold's JoinRequestsPage body itself calls both \`useTranslation()\` and \`useJoinRequestsPage()\`. The \`makeIdHandler\` call-expression helper needs NO hook at all, so it's the simplest fix for a row handler — use it rather than adding a \`useCallback\`. For a zero-arg handler pass a named function reference (\`onClick={handleSubmit}\`), never an inline arrow.

**Form submit — the exact \`no-misused-promises\` + \`jsx-no-bind\` idiom.** react-hook-form's \`handleSubmit(onValid)\` returns a PROMISE-returning function, so both naive attempts are wrong: the direct call expression \`<form onSubmit={form.handleSubmit(onValid)}>\` trips \`@typescript-eslint/no-misused-promises\` ("Promise-returning function provided to attribute where a void return was expected") — a call expression, so \`jsx-no-bind\` is NOT the issue here (per the row-handler rule above) — while wrapping it in an inline arrow \`onSubmit={(e) => form.handleSubmit(onValid)(e)}\` trips \`jsx-no-bind\` AND still leaves the promise misused. The idiom below satisfies both. Do NOT try to patch it by typing the event \`BaseSyntheticEvent\` inline — the fix is STRUCTURAL: the custom hook owns a stable, VOID-returning submit handler and the form JSX passes the bare reference. The scaffold's \`apps/ui/src/features/auth/components/LoginPage/LoginPage.hooks.ts\` shows this STRUCTURE (a \`useCallback\` submit that calls \`void handleSubmit(onValid)(event)\`) — but do NOT copy it verbatim: LoginPage uses \`mutateAsync\` inside a \`try/catch\` because it needs the result to navigate. A plain CRUD form needs no result, so use fire-and-forget \`mutate\` (below) and NO try/catch — never \`mutateAsync\` here.
\`\`\`ts
// in <Component>.hooks.ts (a custom hook — NEVER call useCallback in the component body):
const onSubmit = useCallback(
  (input: ${feature.id}CreateInput): void => {
    // Use \`mutate\` (fire-and-forget), NOT \`mutateAsync\`: the mutation's onSuccess
    // invalidates the list and onError surfaces failures, so this handler never awaits
    // and never rejects. \`mutateAsync\` would REJECT on failure and the \`void\` below would
    // then discard a rejected promise → an unhandled rejection.
    // CLOSE THE FORM ON SUCCESS (see the close-on-success rule below): pass a per-call
    // \`onSuccess\` that hides the form. It runs ALONGSIDE the mutation's own list-invalidating
    // onSuccess (React Query fires both), so the list refetches AND the form disappears.
    createMutation.mutate(input, { onSuccess: closeForm });
  },
  [createMutation.mutate, closeForm] // STABLE \`mutate\` (React Query guarantees it) + the
  // stable \`closeForm\` setter — NOT the whole \`createMutation\` object (recreated every render).
);
const submit = useCallback(
  (event: React.BaseSyntheticEvent): void => {
    void handleSubmit(onSubmit)(event); // \`void\` = the eslint-sanctioned no-misused-promises fix
  },
  [handleSubmit, onSubmit]
);
// …return \`submit\` on the view object the hook exposes.
\`\`\`
\`\`\`tsx
// in the form .tsx — a BARE reference, no arrow, no handleSubmit in JSX:
<form onSubmit={view.submit}>
\`\`\`
\`void handleSubmit(onSubmit)(event)\` makes \`submit\` return \`void\` (the \`void\` operator is exactly typescript-eslint's sanctioned fix for \`no-misused-promises\` on a form's \`onSubmit\`). \`<form onSubmit={view.submit}>\` passes \`jsx-no-bind\` because it's a BARE identifier reference, not an inline arrow — and depending each \`useCallback\` on stable refs only (\`createMutation.mutate\`, \`handleSubmit\`) keeps \`submit\` referentially stable across renders (avoids TanStack's \`no-unstable-deps\`). Keep the onValid handler (\`onSubmit\`) itself non-rejecting — use \`mutate\` as above so mutation failures route to the mutation's \`onError\`, not into this discarded promise. NEVER call \`handleSubmit\` inside JSX.

**Close the create/edit form on SUCCESS — a REQUIRED behaviour, not optional polish.** Browser acceptance opens the create form, fills it, submits, then **waits for the form to DISAPPEAR** as the signal the mutation + list refresh completed, and only THEN checks the new row. A form that submits correctly but stays open FAILS acceptance (\`waiting for …-form to be hidden … N × resolved to visible <form>\`) even though persistence works — so wiring the mutation is NOT enough; you MUST hide the form on success. Own an open/closed flag in the page's view-state hook and pass \`closeForm\` into the submit's per-call \`onSuccess\` (as shown above):
\`\`\`ts
// in <Page>.hooks.ts (view-state — a custom hook, NEVER useState in the component body):
const [showForm, setShowForm] = useState(false);
const openCreate = useCallback((): void => { setShowForm(true); }, []);
const closeForm = useCallback((): void => { setShowForm(false); }, []); // stable → safe onSuccess dep
// …expose \`showForm\`, \`openCreate\`, \`closeForm\`, and \`submit\` on the view object.
\`\`\`
The create button opens it (\`onClick={view.openCreate}\`), the form renders only when \`view.showForm\`, and \`createMutation.mutate(input, { onSuccess: closeForm })\` (and the edit mutation likewise) closes it. \`closeForm\` is a \`useCallback\` with an empty dep array so it's referentially stable — safe as both a \`useCallback\` dep and an \`onSuccess\` handler. A Cancel button also calls \`closeForm\`. Do NOT close the form optimistically before the mutation resolves (a failed create would hide the form with the row never appearing) — close it ONLY in \`onSuccess\`.

**Extract computed lists — the exact \`no-jsx-computation\` idiom.** The rule rejects ANY array method (\`.map\`/\`.filter\`/\`.reduce\`/\`.sort\`/\`.find\`) or arithmetic (\`+\`/\`-\`/\`*\`/\`/\`) called DIRECTLY inside JSX braces — e.g. \`<tbody>{items.map(…)}</tbody>\` or \`<select>{companies.map(…)}</select>\` → "Extract this computation into a hook or helper function". Compute EVERY list/derived value as a \`const\` in the component body, then reference the BARE identifier in JSX:
\`\`\`tsx
const renderRows = items.map((row) => (<tr key={row.id}>…</tr>));
const companyOptions = companies.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>));
// …then in the return:  <tbody>{renderRows}</tbody>   and   <select …>{companyOptions}</select>
\`\`\`
\`{renderRows}\` / \`{companyOptions}\` are plain identifiers, so the rule passes (the scaffold's JoinRequestsPage does exactly this). TRAP that causes a near-green oscillation: if you declare the const but STILL write \`{companies.map(…)}\` inline, you get BOTH \`no-jsx-computation\` (the inline map) AND \`no-unused-vars\` (the ignored const) — and fixing one re-introduces the other. Declare the const AND reference it; never inline the \`.map()\`.

**One concern per file.** The \`.tsx\` is presentational only. Data-fetching hooks live in the generated PascalCase \`${feature.id}.queries.ts\` (list/fetch queries) and \`${feature.id}.mutations.ts\` (create/update/delete mutations) — FILL THESE, do NOT create parallel \`${camel}.hooks.ts\` files. Component view-state hooks go in a co-located \`<Component>.hooks.ts\` next to the component. Pure helpers in \`${camel}.utils.ts\` / \`<Component>.utils.ts\`. Types in \`${camel}.types.ts\`. NEVER put JSX in a \`.ts\` file (JSX only compiles in \`.tsx\`; a \`.ts\` with \`<X>\` throws "Parsing error: '>' expected"). Never mix a hook + component + type in one module.

**Do NOT create new sub-components.** Fill the components the scaffold already generated for this feature (its Page / Form / List and their co-located files) and keep form fields, table rows, and dialogs INLINE in them. Every NEW component you introduce (e.g. \`${feature.id}FormField\`) triggers \`react-component-architecture/component-folder-structure\`, which demands the FULL sibling set in its own PascalCase folder — \`<Name>.tsx\`, \`<Name>.hooks.ts\`, \`<Name>.types.ts\`, \`<Name>.stories.tsx\`, \`<Name>.test.tsx\`, and \`index.ts\` — plus one-concern-per-file across them. That is a lot of scaffolding to get green, so avoid extracting sub-components; if a screen genuinely needs one, create ALL of those siblings in a single pass, not just the \`.tsx\`.

**Test-file extension — JSX ⇒ \`.test.tsx\`.** A test that renders JSX — a component test, OR a hook test that mounts a JSX \`wrapper\` / uses \`renderHook\` with a provider — MUST be named \`.test.tsx\`, never \`.test.ts\`. A \`.ts\` file parses \`<X>\` as a generic and throws "Parsing error: '>' expected". So a component's test is \`<Component>.test.tsx\`; a hook test that mounts JSX is \`<name>.hooks.test.tsx\`. Only a pure-logic test with NO JSX stays \`.test.ts\`.

**Every visible string via \`t("features.${camel}.<key>")\`** — no hardcoded JSX text (button labels like "Edit"/"Delete" included).

**Make the feature reachable.** Add a sidebar link to \`apps/ui/src/components/core/AppSidebar/AppSidebar.tsx\` (add your feature's entry to the \`APP_SIDEBAR_NAV_ITEMS\` array, following the existing format) and register its route in \`apps/ui/src/app/router/routes.tsx\` (add a route pointing at your feature's page component). Both files are in your editable scope — ADD ONLY your feature's entries, never modify another feature's link/route (same rule as the shared schema + locale files). A feature missing from the sidebar or router is unreachable and fails browser acceptance. **After adding your NavLink, update the sidebar's co-located test \`apps/ui/src/components/core/AppSidebar/AppSidebar.test.tsx\`: it asserts the EXACT number of nav links (e.g. \`toHaveLength(6)\`), so bump that count by exactly one for your added link — otherwise the per-feature gate fails THIS cycle (it runs that test), not only the final validate, even though your feature is correct.**

---

## Domain-Fill Instructions

- **Persist for real**: every domain field must be a real column on the \`${camel}\` table (see Persistence above) that the service inserts/selects/updates via Drizzle. NEVER hold a field only in memory to satisfy a test — that stores nothing and is a failed implementation.
- **i18n every UI string**: the gate forbids literal UI text, so every visible string is a \`t("features.${camel}.<key>")\` call. EVERY key you reference MUST exist in the locale files \`apps/ui/src/lib/i18n/locales/<lang>/common.json\` under \`features.${camel}\` — add it to EVERY \`<lang>\` directory (they must stay in parity), or \`i18n-keys/static-translation-key-exists\` fails. Add ONLY keys under \`features.${camel}\`; never edit another feature's keys or other namespaces. If the gate says a key is UNUSED (\`i18n-locale-keys-used\`), it means you wrote the translation but not the code that shows it — WIRE IT UP (render error keys in the mutation's onError as a toast/inline message, a \`confirmDelete\` key in the delete confirmation), NEVER delete a translation you just authored to clear the check. A real app needs those error/confirm states; deleting them ships a worse app and the key just comes back.
- **Use real fields**: Populate schemas and types with meaningful fields that match the resource's behavior (${feature.desc}). Avoid placeholder names like \`field1\`, \`data\`, or \`value\`.
- **Implement real logic**: Write actual service methods that perform the described behaviour. No stubs, no empty functions.
- **No \`as\` type casts**: Use proper types and inference. Cast-free code is a house rule.
- **Validation**: Define meaningful validation rules at each boundary — Elysia TypeBox (\`t.*\`) for the API request/response schemas, Zod only for UI form/runtime validation. Do not use Zod for API schemas.
- **Type safety**: Ensure all functions have explicit parameter and return types.

---

## Freeze

⚠️ **FREEZE**: Only the files above for the **${feature.id}** resource are editable. The shared app schema, locale files, AppSidebar.tsx, and routes.tsx are the explicit ADD-ONLY exceptions: the model may edit them only to add entries for this feature, never to modify other features' entries or remove them. All other files are locked. Do not modify:
- Any table OTHER than \`${camel}\` in the app schema; no migrations
- Any locale namespace OTHER than \`features.${camel}\` in the locale files
- Any sidebar link OTHER than your feature's link; do not modify other features' links
- Any route OTHER than your feature's route; do not modify other features' routes
- Root configuration files
- Other resources' files

If you need to make a change elsewhere, the build has already locked it. Rebase this feature once it passes the gate.

---

## Use the \`check\` tool to see ALL your errors before you stop
Call the \`check\` tool to run the gate (typecheck, lint, meta-rules, knip, AND the API +
UI feature test suites) NOW and get back your WHOLE structured error set
(\`{file, line, rule, message}\`) mid-turn. A failing test reds the gate just like a type
error, so your test siblings must actually PASS — not merely exist. Fix every
error it lists in ONE pass, then \`check\` again — do NOT fix one, stop, and discover the
rest next turn. When \`check\` returns \`passed: true\`, you are done.

Do NOT run the gate through the shell — no \`tsc\`, \`eslint\`, \`knip\`,
\`bun run check\`/\`validate\`/\`typecheck\`, or \`scripts/stack-check.sh\`. The \`check\`
tool is the ONLY gate you run; the shell versions waste turns and, via \`npx\`, resolve a
WRONG \`tsc\` that prints "This is not the tsc command you are looking for". NEVER use
\`npx\`/\`npm\`/\`yarn\` — this stack is bun-only. If you ever must run something else, use
the project's \`bun run <script>\`.

## Do NOT run the browser end-to-end acceptance yourself
The harness runs the full browser (Playwright) acceptance AUTOMATICALLY after the fast gate is
green — it is NOT your job. Do NOT run \`playwright\`/\`bunx playwright test\`, \`bun run dev\`,
\`vite\`, or \`dev.sh\`. The dockerized dev server is already serving the app; starting a second one
on the host is HARD-REFUSED by the \`preflight-host-dev.sh\` guard (exit 1) — that is an
infrastructure guard, NOT a code error, and trying to "fix" it will trap you in a dead loop that
burns the whole turn budget and parks a feature whose code is already correct. When the \`check\`
tool returns \`passed: true\` and your required \`data-testid\`s are present, you are DONE — STOP
there and let the harness verify the browser flow.

---

Begin implementation now.`;
}
