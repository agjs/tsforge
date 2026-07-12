import type { IFeature } from "../greenfield/greenfield.types";
import { toCamelCase } from "./case";

/**
 * Generate the refine prompt that tells the model which files to fill in
 * for one BoringStack resource.
 *
 * The prompt:
 * - Names the resource and its behaviour
 * - Lists the exact generated files the model must fill
 * - Requires test siblings to be written
 * - Includes domain-fill instructions (real fields, real logic, no `as` casts)
 * - States the FREEZE: only this resource's files are editable
 */
export function refinePrompt(feature: IFeature): string {
  const camel = toCamelCase(feature.id);

  // On a retry, lead with the ACTUAL gate/judge errors from the last attempt so the
  // model fixes those specific failures instead of rebuilding blind.
  const priorFailure =
    feature.lastError === undefined || feature.lastError.trim().length === 0
      ? ""
      : `\n\n## ⚠️ Your PREVIOUS attempt FAILED the gate — FIX THESE ERRORS FIRST\n\nThe build gate (typecheck / lint / tests / OpenAPI drift) reported:\n\n\`\`\`\n${feature.lastError}\n\`\`\`\n\nAddress every error above before anything else. The same gate must pass this time.\n\n---`;

  return `You are implementing the **${feature.id}** resource.

**Behavior**: ${feature.desc}${priorFailure}

---

## Files to Implement

You MUST fill in these generated files for the **${feature.id}** resource:

### API Layer (apps/api/src/api/${camel}/)
- \`apps/api/src/api/${camel}/${camel}.schemas.ts\` — Zod schemas for request/response validation
- \`apps/api/src/api/${camel}/${camel}.types.ts\` — TypeScript types for domain entities and DTO objects
- \`apps/api/src/api/${camel}/${camel}.service.ts\` — Service layer business logic

### UI Feature (apps/ui/src/features/${camel}/)
- The complete React feature slice for ${feature.id} (pages, components, hooks, state)

---

## Required Test Siblings

The linter enforces test coverage. You MUST write:

- \`apps/api/tests/api/${camel}/${camel}.routes.test.ts\` — API endpoint tests
- \`apps/api/tests/api/${camel}/${camel}.service.test.ts\` — Service layer unit tests

Without these test files, the build will fail.

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

**Routes** (\`${camel}.routes.ts\`): a schema on EVERY route; NO per-handler try/catch (Elysia \`.onError\` handles errors centrally); NEVER \`throw new Error\` — throw \`ApiErrors.notFound(...)\` / \`.validation(...)\` / \`.unauthorized(...)\`.

**Service** (\`${camel}.service.ts\`): Drizzle + logic; throw \`ApiErrors.*\`; \`catch (err: unknown)\` → \`getErrorMessage(err)\`; singleton export.

**TypeScript (strict-type-checked, all enforced):** no \`any\`, no \`as\` (only \`as const\`), no non-null \`!\`; \`I\`-prefixed interfaces; explicit return types on exported functions; UPPER_CASE top-level constants; no magic string literals in \`===\`/\`switch\` (reference a typed constants object); no inline \`eslint-disable\`.

---

## Domain-Fill Instructions

- **Use real fields**: Populate schemas and types with meaningful fields that match the resource's behavior (${feature.desc}). Avoid placeholder names like \`field1\`, \`data\`, or \`value\`.
- **Implement real logic**: Write actual service methods that perform the described behaviour. No stubs, no empty functions.
- **No \`as\` type casts**: Use proper types and inference. Cast-free code is a house rule.
- **Validation**: Define appropriate Zod schemas with meaningful validation rules.
- **Type safety**: Ensure all functions have explicit parameter and return types.

---

## Freeze

⚠️ **FREEZE**: Only the files above for the **${feature.id}** resource are editable. All other files in the repository are locked. Do not modify:
- Database schemas or migrations
- Root configuration files
- Routes wiring (already done for this resource)
- Other resources' files

If you need to make a change elsewhere, the build has already locked it. Rebase this feature once it passes the gate.

---

Begin implementation now.`;
}
