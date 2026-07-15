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

  return `You are implementing the **${feature.id}** resource.

**Behavior**: ${feature.desc}${priorFailure}${productContext}

---

## Files to Implement

You MUST fill in these generated files for the **${feature.id}** resource:

### Persistence (apps/api/src/clients/postgres/schema/app.schema.ts)
- The \`${camel}\` Drizzle table is generated with only stub columns (\`id\`, \`userId\`, \`name\`, timestamps). **Add the real domain columns to it** — one column per field listed under Product Context above (choose the right Drizzle type: \`varchar\`/\`text\` for strings, \`boolean().notNull().default(false)\` for booleans, \`integer\`/\`numeric\` for numbers, \`timestamp\` for dates; make \`[optional]\` fields nullable). These columns are what actually persists — the service and types must read/write REAL columns, never in-memory-only fields.
- **Import every column builder you use.** If you add a \`boolean\`/\`text\`/\`integer\`/\`numeric\`/\`jsonb\` column, that identifier MUST be added to the existing \`import { ... } from "drizzle-orm/pg-core"\` line at the top of the file. A missing import is a \`ReferenceError\` that crashes the API on boot — the #1 cause of a failed build here.
- Edit ONLY the \`${camel}\` table. Do NOT touch any other table in this file.

### API Layer (apps/api/src/api/${camel}/)
- \`apps/api/src/api/${camel}/${camel}.schemas.ts\` — request/response validation schemas using **Elysia TypeBox** (\`import { t } from "elysia"\` → \`t.Object({ title: t.String(), … })\`). This is the API boundary — do NOT use Zod here; Zod is only for UI form/runtime validation.
- \`apps/api/src/api/${camel}/${camel}.types.ts\` — TypeScript types for domain entities and DTO objects
- \`apps/api/src/api/${camel}/${camel}.service.ts\` — Service layer business logic
- \`apps/api/src/api/${camel}/${camel}.routes.ts\` — Elysia routes: a schema on EVERY route; \`ApiErrors.*\` for errors (never \`throw new Error\`)

### UI Feature (apps/ui/src/features/${camel}/)
- The complete React feature slice for ${feature.id} (pages, components, hooks, state)

---

## Required Test Siblings

The linter enforces test coverage. You MUST write:

- \`apps/api/tests/api/${camel}/${camel}.routes.test.ts\` — API endpoint tests
- \`apps/api/tests/api/${camel}/${camel}.service.test.ts\` — Service layer unit tests

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
- **i18n every UI string**: the gate forbids literal UI text, so every visible string is a \`t("features.${camel}.<key>")\` call. EVERY key you reference MUST exist in the locale files \`apps/ui/src/lib/i18n/locales/<lang>/common.json\` under \`features.${camel}\` — add it to EVERY \`<lang>\` directory (they must stay in parity), or \`i18n-keys/static-translation-key-exists\` fails. Add ONLY keys under \`features.${camel}\`; never edit another feature's keys or other namespaces.
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
