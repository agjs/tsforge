import type { IFeature } from "../greenfield/greenfield.types";
import type { ISlice } from "../planning/plan-types";
import { toCamelCase } from "./case";

function productContextSection(slice: ISlice): string {
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
export function refinePrompt(feature: IFeature, slice?: ISlice): string {
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
- **Mutations** (\`${feature.id}.mutations.ts\` — PascalCase file in \`apps/ui/src/features/${camel}/\`): implement real \`useCreate${feature.id}\`, \`useUpdate${feature.id}\`, and \`useDelete${feature.id}\` — each calls \`@/lib/api/client\` (\`apiClient.POST/PATCH/DELETE\`). **The client's \`throwOnError\` middleware THROWS an \`ApiError\` on any non-2xx — it does NOT return an error to check.** So \`error\` is typed \`undefined\`: writing \`if (error) throw error\` is a DEAD \`no-unnecessary-condition\` (error can't be truthy) AND \`only-throw-error\` (you'd be throwing \`undefined\`). Just read \`data\`: \`const { data } = await apiClient.POST(…); return data;\`. React Query catches the thrown ApiError, so invalidate the list query in \`onSuccess\` and surface failures in \`onError\` — never guard \`error\`. Do NOT leave the stub that returns its input.
  (Use the REAL domain fields of ${feature.id} — ${domainFields} — NOT a single placeholder \`name\`.)
- **List query** (\`${feature.id}.queries.ts\` — PascalCase file): implement \`use${feature.id}\` to actually fetch via \`apiClient.GET\` (the scaffold stub returns \`[]\`, so the list is permanently empty and create→appears-in-list is impossible until you do this). Same throwing-client rule as mutations: the queryFn just \`const { data } = await apiClient.GET(…); return data;\` — do NOT check \`error\` (it is typed \`undefined\`; the \`throwOnError\` middleware already throws and React Query catches it into the query's error state).
- **List**: render the fetched records (not just an empty state) — one row per record showing those domain fields, each row with **Edit** and **Delete** actions.
- **Create/Edit form**: one input per domain field. Validate with Zod; on submit call the create/update mutation; on error render \`t("features.${camel}.<action>Error")\`.
- **Delete**: a confirmation using \`t("features.${camel}.confirmDelete")\` that calls \`useDelete${feature.id}\`.
- The UI must carry out the feature's flow end to end (create → it appears in the list → edit → delete). Wiring the mutations into a real form + list is what makes the i18n error/confirm keys "used" — that is the intended way to clear \`i18n-locale-keys-used\`, never by deleting keys.

---

## Required Test Siblings

The linter enforces test coverage — **every logic file you add or change needs a mirrored test sibling**, API and UI alike:

- \`apps/api/tests/api/${camel}/${camel}.routes.test.ts\` — API endpoint tests covering create/update/delete, not just list.
- \`apps/api/tests/api/${camel}/${camel}.service.test.ts\` — Service layer unit tests. **These MUST include an ownership-isolation test that PROVES the userId scoping above:** create a row as user A, then assert user B's \`getForUser\`/\`updateForUser\`/\`deleteForUser\` on that id find/affect NOTHING (returns not-found / 0 rows — the same as a missing id), and that user A still can. Without this test the id-only privilege-escalation bug passes the gate — prose alone does not stop it.
- \`apps/ui/src/features/${camel}/…\` — **vitest**, a co-located mirrored test for every UI logic file you write (mutations/hooks/form). Beyond unit-testing the mutations (mock \`@/lib/api/client\`, assert \`useCreate${feature.id}\`/\`useUpdate${feature.id}\`/\`useDelete${feature.id}\` call it), include a test that RENDERS the feature page and drives the REAL flow through the list: fill the create form and submit (assert the create mutation fires), then trigger a rendered row's **Edit** (assert the update mutation fires) and **Delete** confirmation (assert the delete mutation fires). A test that only checks the hooks call the client — or that exercises create alone — can pass while update/delete stay disconnected from the page and the feature is still hollow; it MUST drive edit and delete from the rendered list.

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

⚠️ **FREEZE**: Only the files above for the **${feature.id}** resource are editable — that includes adding your entity's columns to the \`${camel}\` table in the app schema. All other files are locked. Do not modify:
- Any table OTHER than \`${camel}\` in the app schema; no migrations
- Root configuration files
- Routes wiring (already done for this resource)
- Other resources' files

If you need to make a change elsewhere, the build has already locked it. Rebase this feature once it passes the gate.

---

## Do NOT run the gate yourself
The harness runs the full gate (typecheck, lint, meta-rules, knip, tests) after your
edits and hands you the exact errors. Do NOT run \`tsc\`, \`eslint\`, \`knip\`,
\`bun run check\`/\`validate\`/\`typecheck\`, or \`scripts/stack-check.sh\` yourself —
it wastes turns and tells you nothing the harness won't. Just edit; the gate report
is your feedback. And NEVER use \`npx\` (or \`npm\`/\`yarn\`) — this stack is bun-only,
and \`npx tsc\` resolves a WRONG package that prints "This is not the tsc command you
are looking for". If you ever must run something, use the project's \`bun run <script>\`.

---

Begin implementation now.`;
}
