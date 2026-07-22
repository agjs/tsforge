import type {
  AcceptStep,
  IEntityAcceptance,
  IAcceptanceSpec,
  IParentRef,
} from "../../acceptance/acceptance.types";
import { testIdsFor } from "../../acceptance/acceptance-spec";

/**
 * Generate a canonical test title for a given acceptance step.
 * Used by both the spec generator (for test names) and the runner (for parsing results back).
 * This ensures single-source-of-truth for step title matching.
 */
export function stepTitle(
  step: AcceptStep,
  entityKey: string,
  entityId: string
): string {
  switch (step) {
    case "nav":
      return `navigate to ${entityKey} list via sidebar`;
    case "list":
      return `${entityKey} list is present or empty state shown`;
    case "create":
      return `create ${entityId}: form fill, submit, row appears`;
    case "persist":
      return `${entityId} persists after page reload`;
    case "update":
      return `update ${entityId}: edit form, change field, save`;
    case "delete":
      return `delete ${entityId}: row delete, confirm, row gone`;
    case "negative":
      // Negative titles include field and value; handled separately in generateNegativeBlocks
      return "negative";
  }
}

/**
 * Generate a canonical test title for chain-create steps (FIX A: single source of truth).
 * Used by both the spec generator (for test names) and the runner (for parsing results back).
 * Ensures parseStep recognizes every title the generator emits.
 */
export function chainCreateTitle(
  kind: "root" | "child" | "standalone",
  entityId: string
): string {
  switch (kind) {
    case "root":
      return `create root entity: ${entityId}`;
    case "child":
      return `create child entity: ${entityId} with parent linkage`;
    case "standalone":
      return `create entity: ${entityId} (no parent linkage)`;
  }
}

/**
 * Generate API seeding code for parent entities before form submission.
 * Recursively seeds parents in topologically ordered (DFS post-order) so parent FK
 * fields reference real seeded IDs rather than placeholders. For a 2+ level chain
 * (e.g. Deal→Contact→Company), Company is seeded first, then Contact with a real
 * companyId variable reference, then Deal with a real contactId variable reference.
 * Returns TypeScript code that declares parentId variables in dependency order.
 */
/**
 * Build the payload object for seeding a parent via API.
 * Includes required fields with FK fields using var refs, regular fields using valid values.
 */
function buildParentPayload(
  parentDef: IEntityAcceptance,
  parentEntity: string,
  entityId: string
): string {
  const payloadParts: string[] = [];

  for (const field of parentDef.fields) {
    if (!field.optional) {
      // Check if this field is an FK field (matches a parent's fkField)
      const isFkField = parentDef.parents.some((p) => p.fkField === field.name);

      if (isFkField) {
        // Use the real seeded var reference
        const fkParent = parentDef.parents.find(
          (p) => p.fkField === field.name
        );

        if (fkParent) {
          const fkVarName = `${fkParent.key}Id`;

          payloadParts.push(`${field.name}: ${fkVarName}`);
        }
      } else {
        // Use the valid value as a string literal
        payloadParts.push(`${field.name}: ${JSON.stringify(field.valid)}`);
      }
    }
  }

  // Fallback: if no required fields, add a name
  if (payloadParts.length === 0) {
    payloadParts.push(`name: "${parentEntity}-for-${entityId}"`);
  }

  return `{ ${payloadParts.join(", ")} }`;
}

/**
 * Emit seeding code for a parent with fallback handling (no spec available).
 */
function emitFallbackParentSeed(
  parentKey: string,
  parentEntity: string,
  entityId: string
): string {
  const varName = `${parentKey}Id`;

  return `    // Seed a parent ${parentEntity} record (no spec available)
    const ${varName} = await (async () => {
      const apiBase = process.env.VITE_API_BASE || "http://localhost:7331";
      const res = await fetch(\`\${apiBase}/api/v1/${parentKey}\`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": await page.context().cookies().then(c => c.map(x => \`\${x.name}=\${x.value}\`).join("; ")),
        },
        body: JSON.stringify({ name: "${parentEntity}-for-${entityId}" }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(\`Failed to seed ${parentEntity} (HTTP \${res.status}): \${body}\`);
      }
      const data = await res.json();
      const parentId = data.id;
      if (typeof parentId !== "string") {
        throw new Error(\`Seeded ${parentEntity} but no id in response: \${JSON.stringify(data)}\`);
      }
      return parentId;
    })();`;
}

/**
 * Emit seeding code for a parent with full spec (includes FK linking).
 */
function emitSpecParentSeed(
  parentKey: string,
  parentEntity: string,
  payloadCode: string
): string {
  const varName = `${parentKey}Id`;

  return `    // Seed parent ${parentEntity} with required fields and real FK references
    const ${varName} = await (async () => {
      const apiBase = process.env.VITE_API_BASE || "http://localhost:7331";
      const res = await fetch(\`\${apiBase}/api/v1/${parentKey}\`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": await page.context().cookies().then(c => c.map(x => \`\${x.name}=\${x.value}\`).join("; ")),
        },
        body: JSON.stringify(${payloadCode}),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(\`Failed to seed ${parentEntity} (HTTP \${res.status}): \${body}\`);
      }
      const data = await res.json();
      const parentId = data.id;
      if (typeof parentId !== "string") {
        throw new Error(\`Seeded ${parentEntity} but no id in response: \${JSON.stringify(data)}\`);
      }
      return parentId;
    })();`;
}

function generateParentSeedingCode(
  parents: IParentRef[],
  entityId: string,
  spec?: IAcceptanceSpec
): string {
  if (parents.length === 0) {
    return "";
  }

  const visited = new Set<string>();
  const codeBlocks: string[] = [];
  const maxDepth = 5;

  function emitParentSeeding(
    parentKey: string,
    parentEntity: string,
    depth: number
  ): void {
    // Guard: prevent cycles and excessive depth
    if (visited.has(parentKey) || depth > maxDepth) {
      return;
    }

    visited.add(parentKey);

    // Find the parent entity in the spec
    const parentDef = spec?.entities.find((e) => e.key === parentKey);

    if (!parentDef) {
      codeBlocks.push(
        emitFallbackParentSeed(parentKey, parentEntity, entityId)
      );

      return;
    }

    // RECURSIVELY emit seeding for THIS parent's parents FIRST (topological order)
    for (const grandparent of parentDef.parents) {
      emitParentSeeding(grandparent.key, grandparent.entity, depth + 1);
    }

    // Now emit THIS parent's seeding
    const payloadCode = buildParentPayload(parentDef, parentEntity, entityId);

    codeBlocks.push(emitSpecParentSeed(parentKey, parentEntity, payloadCode));
  }

  // Emit seeding for all direct parents (which recursively emits grandparents first)
  for (const parent of parents) {
    emitParentSeeding(parent.key, parent.entity, 0);
  }

  return codeBlocks.join("\n");
}

/**
 * Render a field value to a code literal string.
 * For numeric types (exact match), renders as a bare number or falls back to string for NaN.
 * For boolean types (exact match), renders as a bare boolean.
 * For everything else, renders as a JSON string.
 * Complexity: ≤ 20 (normalized type match with fallback).
 */
function renderFieldValue(field: { type: string; valid: string }): string {
  const normalized = field.type.toLowerCase().trim();

  // Numeric types: exact match against known numeric type names
  const numericTypes = new Set([
    "number",
    "integer",
    "int",
    "float",
    "double",
    "decimal",
    "numeric",
  ]);

  if (numericTypes.has(normalized)) {
    const num = Number(field.valid);

    // Guard NaN → fall back to JSON string
    if (Number.isNaN(num)) {
      return JSON.stringify(field.valid);
    }

    return String(num);
  }

  // Boolean types: exact match against known boolean type names
  const booleanTypes = new Set(["boolean", "bool"]);

  if (booleanTypes.has(normalized)) {
    return field.valid.trim().toLowerCase() === "true" ? "true" : "false";
  }

  // Everything else: JSON string
  return JSON.stringify(field.valid);
}

/**
 * Generate field fill steps for form inputs.
 * FIX D: Type-aware field fills (select/checkbox/date/number) instead of blanket .fill().
 * Each step safely interpolates field.valid using JSON.stringify.
 * @param skipForeignKeys - if true, skip FK fields (used for chain specs where parent selection is handled separately)
 */
function generateFieldFillSteps(
  entity: IEntityAcceptance,
  ids: ReturnType<typeof testIdsFor>,
  skipForeignKeys = false
): string {
  return entity.fields
    .map((field) => {
      const isFK = entity.parents.some((p) => p.fkField === field.name);

      if (isFK) {
        if (skipForeignKeys) {
          // Skip FK fields entirely; they'll be selected separately in chain context
          return "";
        }

        const parent = entity.parents.find((p) => p.fkField === field.name);

        if (parent) {
          const varName = `${parent.key}Id`;

          return `    await page.getByTestId("${ids.field(field.name)}").selectOption(${varName});`;
        }
      }

      // FIX D: Type-aware fill based on field.type
      const fieldType = field.type.toLowerCase();

      // Select/enum/option type
      if (
        fieldType.includes("select") ||
        fieldType.includes("enum") ||
        fieldType.includes("option")
      ) {
        return `    await page.getByTestId("${ids.field(field.name)}").selectOption(${JSON.stringify(field.valid)});`;
      }

      // Boolean/checkbox type
      if (fieldType.includes("bool") || fieldType.includes("checkbox")) {
        // Check if field.valid is truthy (treat non-empty string as truthy)
        const shouldCheck = field.valid !== "" && field.valid !== "false";

        return `    await page.getByTestId("${ids.field(field.name)}").${
          shouldCheck ? "check" : "uncheck"
        }();`;
      }

      // Everything else (string/text/email/number/date) uses fill
      return `    await page.getByTestId("${ids.field(field.name)}").fill(${JSON.stringify(field.valid)});`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Generate row cell assertions for created values.
 * For parent references, assert the linkage cell contains the parent's SEEDED identity value
 * (not the type name — ensures the actual relationship is displayed).
 * For regular fields, assert cell contains the expected value.
 * Safely interpolates field values using JSON.stringify.
 */
function generateRowCellAssertions(
  entity: IEntityAcceptance,
  ids: ReturnType<typeof testIdsFor>,
  spec?: IAcceptanceSpec
): string {
  return entity.shows
    .map((show) => {
      // Check if this show is a parent reference
      const isParent = entity.parents.some((p) => p.key === show);

      if (isParent) {
        // For parent references, assert the cell contains the SEEDED parent identity value.
        // If spec is available, use the parent's identity field value (first string field or first field's .valid).
        // If no spec (fallback seeding), assert the type name (which matches the fallback seed format).
        const parentDef = entity.parents.find((p) => p.key === show);

        if (parentDef) {
          let expectedValue = parentDef.entity; // Default: type name (fallback seeding case)

          // If spec is available, derive the parent's actual identity display value
          if (spec) {
            const parentEntity = spec.entities.find(
              (e) => e.key === parentDef.key
            );

            if (parentEntity && parentEntity.fields.length > 0) {
              // Find the first string-typed field, or fall back to first field
              const stringTypePatterns = ["string", "text", "email"];
              const identityField =
                parentEntity.fields.find((f) =>
                  stringTypePatterns.some((type) =>
                    f.type.toLowerCase().includes(type)
                  )
                ) ?? parentEntity.fields[0];

              if (identityField) {
                expectedValue = identityField.valid;
              }
            }
          }

          return `    await expect(row.getByTestId("${ids.rowCell(show)}")).toContainText(${JSON.stringify(expectedValue)});`;
        }
      }

      // For regular fields, assert the value is present in THIS row only
      const value = entity.fields.find((f) => f.name === show)?.valid ?? show;

      return `    await expect(row.getByTestId("${ids.rowCell(show)}")).toContainText(${JSON.stringify(value)});`;
    })
    .join("\n");
}

/**
 * Generate negative test blocks.
 * B2: Ensures test title and assertions use JSON.stringify for injection-safe escaping.
 * B3: Overrides the invalid field using renderFieldValue (type-aware), except
 *     required-empty "" stays as empty string to test missing-required constraint.
 *
 * Negatives work by:
 * 1. Authenticate and seed parent entities via API
 * 2. Build a payload with all required non-FK fields (valid values) + FK fields (seeded ids)
 * 3. Override the target field with the invalid value (type-rendered, or "" for required-empty)
 * 4. POST directly to /api/v1/<entity> and assert a 400 or 422 response (validation error codes)
 *
 * This deterministic API-level check proves validation is enforced without depending on
 * browser form interaction or visible error elements. Only accepting 400/422 prevents
 * false-positive passes from 401/403/404/409 auth/routing/conflict errors.
 */
function generateNegativeBlocks(
  entity: IEntityAcceptance,
  parentSeedingCode: string
): string {
  return entity.negatives
    .map((neg) => {
      // B2: Test title uses JSON.stringify to escape backticks/interpolation in neg.value
      const testTitle = `negative: ${entity.id} rejects ${neg.field}=${neg.value}`;

      // Build valid field assignments (required non-FK fields)
      const validFieldAssignments = entity.fields
        .filter((f) => !f.optional)
        .filter((f) => !entity.parents.some((p) => p.fkField === f.name))
        .map((f) => `      ${f.name}: ${renderFieldValue(f)}`);

      // Build FK field assignments
      const fkFieldAssignments = entity.parents.map(
        (p) => `      ${p.fkField}: ${p.key}Id`
      );

      // Combine all assignments, filtering out empties
      const allAssignments = [
        ...validFieldAssignments,
        ...fkFieldAssignments,
      ].filter((s) => s.length > 0);
      const payloadFields = allAssignments.join(",\n");

      // B3: Render the override value verbatim via JSON.stringify (except required-empty "")
      // to ensure invalid values are sent as-is (e.g., "notabool" stays "notabool", not coerced to false).
      // Only the VALID companion fields get type-rendering; the override does not.
      const overrideValue = neg.value === "" ? '""' : JSON.stringify(neg.value);

      // B2: Build error message safely without backtick interpolation of plan data
      const errorMsg = `expected ${entity.key} to reject ${neg.field} with a validation error (400/422)`;

      return `  test(${JSON.stringify(testTitle)}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();

${parentSeedingCode}

    const apiBase = process.env.VITE_API_BASE || "http://localhost:7331";
    const cookieHeader = await page
      .context()
      .cookies()
      .then((cs) => cs.map((c) => \`\${c.name}=\${c.value}\`).join("; "));

    // A payload that is valid EXCEPT for the field under test (overridden with the invalid value).
    const payload: Record<string, unknown> = {
${payloadFields}
    };
    payload[${JSON.stringify(neg.field)}] = ${overrideValue};

    const res = await page.request.post(\`\${apiBase}/api/v1/${entity.key}\`, {
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      data: payload,
    });

    // Invalid input MUST be rejected with a validation error (400 or 422), not any 4xx.
    // 401/403/404/409 are auth/routing/conflict errors that do not prove field validation.
    expect(
      [400, 422].includes(res.status()),
      ${JSON.stringify(errorMsg)} + \`, got \${res.status()}\`
    ).toBe(true);
  });
`;
    })
    .join("\n");
}

/**
 * Generate a navigation helper function for an entity.
 * Used by both generateEntitySpec and generateChainSpec to avoid duplication.
 */
function generateNavHelper(entity: IEntityAcceptance): string {
  return `async function navigateTo${entity.id}(page: import("@playwright/test").Page) {
  const uiBase = process.env.PLAYWRIGHT_HOST || "http://localhost";
  const uiPort = process.env.PLAYWRIGHT_PORT || "7331";
  await page.goto(\`\${uiBase}:\${uiPort}/${entity.key}\`, { waitUntil: "domcontentloaded" });
}`;
}

/**
 * Generate a Playwright spec text for a single entity's CRUD operations.
 * Returns a `.spec.ts` string ready to write to disk.
 *
 * Covers: nav, list (or empty), create, persist (reload), update, delete, and negative cases.
 * Uses the app's authedPage fixture and getByTestId selectors.
 * For entities with parents, seeds the parent via API and selects it in the form.
 */
export function generateEntitySpec(
  entity: IEntityAcceptance,
  spec?: IAcceptanceSpec
): string {
  const ids = testIdsFor(entity.key);
  const name = entity.id;
  const fieldFillSteps = generateFieldFillSteps(entity, ids);
  const rowCellAssertions = generateRowCellAssertions(entity, ids, spec);
  const parentSeedingCode = generateParentSeedingCode(
    entity.parents,
    entity.id,
    spec
  );
  const negativeBlocks = generateNegativeBlocks(entity, parentSeedingCode);

  // FIX E/FIX 3: Type-aware unique identity value
  // Find the first field with a string/text type (NOT email by type or name) for the unique marker
  // Email fields with timestamp suffix are invalid emails, so we exclude them
  const identityField =
    entity.fields.find((f) => {
      const fieldType = f.type.toLowerCase();
      const fieldNameLower = f.name.toLowerCase();

      return (
        (fieldType.includes("string") || fieldType.includes("text")) &&
        !fieldType.includes("email") &&
        !fieldNameLower.includes("email")
      );
    }) ?? entity.fields[0];
  const identityFieldName = identityField?.name ?? "name";
  const identityFieldValid = identityField?.valid ?? "updated";
  const firstFieldName = entity.fields[0]?.name ?? "name";
  const firstFieldValid = entity.fields[0]?.valid ?? "updated";

  // Determine if we need to fill the first field separately from the identity field
  const isFirstFieldIdentity = identityFieldName === firstFieldName;
  const fillFirstFieldCode = isFirstFieldIdentity
    ? ""
    : `    await page.getByTestId("${ids.field(firstFieldName)}").fill(${JSON.stringify(firstFieldValid)});\n`;

  // FIX 3: If identity field is an email, build a unique email with a valid local part
  const identityFieldType = identityField?.type.toLowerCase() ?? "";
  const identityFieldNameLower = identityField?.name.toLowerCase() ?? "";
  const isIdentityEmail =
    identityFieldType.includes("email") ||
    identityFieldNameLower.includes("email");

  const uniqueValueConstruction = isIdentityEmail
    ? `(() => {
      // For email fields, construct a valid unique email by splitting the valid value and inserting a unique token
      const match = ${JSON.stringify(identityFieldValid)}.match(/^([^@]+)@(.+)$/);
      if (match) {
        const localPart = match[1];
        const domain = match[2];
        return localPart + "+" + Date.now() + "-" + Math.floor(Math.random() * 1000000) + "@" + domain;
      }
      // Fallback if valid email doesn't have @ (shouldn't happen with valid email field)
      return ${JSON.stringify(identityFieldValid)} + "-" + Date.now();
    })()`
    : `${JSON.stringify(identityFieldValid)} + "-" + Date.now() + "-" + Math.floor(Math.random() * 1000000)`;

  return `import { expect, test } from "./auth-helper";

${generateNavHelper(entity)}

test.describe(${JSON.stringify(name)}, () => {
  test(${JSON.stringify(stepTitle("nav", entity.key, entity.id))}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await page.getByTestId("${ids.nav}").click();
    await page.waitForURL(/${entity.key}(?:\\/|$)/);
    await expect(page).toHaveURL(/${entity.key}(?:\\/|$)/);
  });

  test(${JSON.stringify(stepTitle("list", entity.key, entity.id))}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    // Wait for either list or empty state to appear (with timeout)
    try {
      await Promise.race([
        page.getByTestId("${ids.list}").first().waitFor({ state: "visible", timeout: 5000 }),
        page.getByTestId("${ids.empty}").waitFor({ state: "visible", timeout: 5000 }),
      ]);
    } catch {
      // If neither appears, just check if they're in the DOM
      const listPresent = await page.getByTestId("${ids.list}").isVisible().catch(() => false);
      const emptyPresent = await page.getByTestId("${ids.empty}").isVisible().catch(() => false);

      if (!listPresent && !emptyPresent) {
        throw new Error("Neither list nor empty state visible after 5s");
      }
    }
  });

  test(${JSON.stringify(stepTitle("create", entity.key, name))}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    // Unique value → this test asserts on ITS OWN row (the shared DB accumulates rows
    // across tests/runs, so absolute row counts are unreliable).
    // Identity field gets the unique marker (type-aware: may not be the first field)
    // FIX 3: For email fields, construct a valid unique email (not just a timestamp suffix)
    const unique = ${uniqueValueConstruction};

    // Click create button
    await page.getByTestId("${ids.create}").click();
    // Wait for form to appear (form may be inline, no URL change)
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${parentSeedingCode}

    // Fill all fields
${fieldFillSteps}
${fillFirstFieldCode}    // Fill identity field with unique value
    await page.getByTestId("${ids.field(identityFieldName)}").fill(unique);

    // Submit
    await page.getByTestId("${ids.submit}").click();
    // Wait for form to disappear (indicates mutation + list refresh completed)
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 10000 });

    // THIS test's row (identified by its unique value) appears — retries the async refetch
    const row = page.getByTestId("${ids.row}").filter({ hasText: unique });
    await expect(row).toBeVisible({ timeout: 10000 });

    // Verify the shown cells render the created values (scoped to THIS row only)
${rowCellAssertions}
  });

  test(${JSON.stringify(stepTitle("persist", entity.key, name))}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    const unique = ${uniqueValueConstruction};

    // Create a new record stamped with the unique value
    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${parentSeedingCode}

${fieldFillSteps}
${fillFirstFieldCode}    await page.getByTestId("${ids.field(identityFieldName)}").fill(unique);

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 10000 });

    // Reload the page
    await page.reload();
    await page.waitForURL(/\\/${entity.key}/);

    // THIS test's row survives the reload
    const reloadedRow = page.getByTestId("${ids.row}").filter({ hasText: unique });
    await expect(reloadedRow).toBeVisible({ timeout: 10000 });

    // FIX F: Assert relationship linkage after reload (not only optimistic UI)
${
  entity.parents.length > 0
    ? `    // Verify parent linkage persists after reload
${entity.parents
  .map((parent) => {
    const parentDef = spec?.entities.find((e) => e.key === parent.key);
    let expectedValue = parent.entity; // Fallback: type name

    if (parentDef !== undefined && parentDef.fields.length > 0) {
      const stringField =
        parentDef.fields.find((f) => {
          const ft = f.type.toLowerCase();

          return (
            (ft.includes("string") || ft.includes("text")) &&
            !ft.includes("email")
          );
        }) ?? parentDef.fields[0];

      if (stringField !== undefined) {
        expectedValue = stringField.valid;
      }
    }

    return `    await expect(reloadedRow.getByTestId("${ids.rowCell(parent.key)}")).toContainText(${JSON.stringify(expectedValue)});`;
  })
  .join("\n")}`
    : ""
}
  });

  test(${JSON.stringify(stepTitle("update", entity.key, name))}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    // Create a record stamped with a unique value (identity field, not first field)
    // FIX 3: For email fields, construct a valid unique email
    const unique = ${uniqueValueConstruction};
    const updatedValue = ${
      isIdentityEmail
        ? `(() => {
      const match = unique.match(/^([^@]+)@(.+)$/);
      return match ? match[1] + "-updated@" + match[2] : unique + "-updated";
    })()`
        : `unique + "-updated"`
    };

    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${parentSeedingCode}

${fieldFillSteps}
${fillFirstFieldCode}    await page.getByTestId("${ids.field(identityFieldName)}").fill(unique);

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 10000 });

    // Edit THIS row (located by its unique value, not position)
    const createdRow = page.getByTestId("${ids.row}").filter({ hasText: unique });
    await expect(createdRow).toBeVisible({ timeout: 10000 });
    await createdRow.getByTestId("${ids.rowEdit}").click();

    // Edit inputs appear — inline in the row OR in a reopened form. Either way the
    // field testid becomes editable (do NOT assume the create form is reused).
    const editField = page.getByTestId("${ids.field(identityFieldName)}");
    await editField.waitFor({ state: "visible", timeout: 5000 });
    await editField.clear();
    await editField.fill(updatedValue);
    await page.getByTestId("${ids.submit}").click();

    // The updated value is now shown in the list
    await expect(
      page.getByTestId("${ids.row}").filter({ hasText: updatedValue })
    ).toBeVisible({ timeout: 10000 });

    // Reload the page and verify the update persists
    await page.reload();
    await page.waitForURL(/\\/${entity.key}/);

    // After reload, the row should still contain the updated value
    await expect(
      page.getByTestId("${ids.row}").filter({ hasText: updatedValue })
    ).toBeVisible({ timeout: 10000 });
  });

  test(${JSON.stringify(stepTitle("delete", entity.key, name))}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    const unique = ${uniqueValueConstruction};

    // Create a record stamped with the unique value
    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${parentSeedingCode}

${fieldFillSteps}
${fillFirstFieldCode}    await page.getByTestId("${ids.field(identityFieldName)}").fill(unique);

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 10000 });

    // Locate THIS test's row (by its unique value) and delete it — not by position
    const createdRow = page.getByTestId("${ids.row}").filter({ hasText: unique });
    await expect(createdRow).toBeVisible({ timeout: 10000 });
    await createdRow.getByTestId("${ids.rowDelete}").click();

    // Confirm delete if a confirmation control appears
    const confirmButton = page.getByTestId("${ids.confirmDelete}");
    if ((await confirmButton.count()) > 0) {
      await confirmButton.first().click();
    }

    // THIS row is gone — retries through the async list update
    await expect(
      page.getByTestId("${ids.row}").filter({ hasText: unique })
    ).toHaveCount(0, { timeout: 10000 });

    // Reload the page and verify the deletion persists
    await page.reload();
    await page.waitForURL(/\\/${entity.key}/);

    // After reload, the deleted row must still be gone
    await expect(
      page.getByTestId("${ids.row}").filter({ hasText: unique })
    ).toHaveCount(0, { timeout: 10000 });
  });

${negativeBlocks}
});
`;
}

/**
 * Generate test code for a root entity in the chain.
 */
function generateRootEntityChainTest(
  entity: IEntityAcceptance,
  index: number,
  _spec: IAcceptanceSpec
): {
  varName: string;
  testStep: string;
} {
  const ids = testIdsFor(entity.key);
  const fieldFill = generateFieldFillSteps(entity, ids, false);

  // FIX E/FIX 3: Type-aware identity for chain tests (NOT email by type or name)
  const identityField =
    entity.fields.find((f) => {
      const fieldType = f.type.toLowerCase();
      const fieldNameLower = f.name.toLowerCase();

      return (
        (fieldType.includes("string") || fieldType.includes("text")) &&
        !fieldType.includes("email") &&
        !fieldNameLower.includes("email")
      );
    }) ?? entity.fields[0];
  const identityFieldName = identityField?.name ?? "name";
  const identityFieldValid = identityField?.valid ?? "updated";
  const firstFieldName = entity.fields[0]?.name ?? "name";
  const firstFieldValid = entity.fields[0]?.valid ?? "updated";
  const isFirstFieldIdentity = identityFieldName === firstFieldName;
  const fillFirstFieldCode = isFirstFieldIdentity
    ? ""
    : `\n    await page.getByTestId("${ids.field(firstFieldName)}").fill(${JSON.stringify(firstFieldValid)});`;
  const varName = `parent${index}Unique`;
  const testTitle = chainCreateTitle("root", entity.id);

  // FIX 3: If identity field is an email, build a unique email with a valid local part
  const identityFieldType = identityField?.type.toLowerCase() ?? "";
  const identityFieldNameLower = identityField?.name.toLowerCase() ?? "";
  const isIdentityEmail =
    identityFieldType.includes("email") ||
    identityFieldNameLower.includes("email");

  const uniqueValueConstruction = isIdentityEmail
    ? `(() => {
      const match = ${JSON.stringify(identityFieldValid)}.match(/^([^@]+)@(.+)$/);
      if (match) {
        const localPart = match[1];
        const domain = match[2];
        return localPart + "-root-" + Date.now() + "-" + Math.floor(Math.random() * 1000000) + "@" + domain;
      }
      return ${JSON.stringify(identityFieldValid)} + "-root-" + Date.now();
    })()`
    : `${JSON.stringify(identityFieldValid)} + "-root-" + Date.now() + "-" + Math.floor(Math.random() * 1000000)`;

  const testStep = `  test(${JSON.stringify(testTitle)}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    // Create unique root entity identifier
    // FIX 3: For email fields, construct a valid unique email
    const unique = ${uniqueValueConstruction};

    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${fieldFill}${fillFirstFieldCode}
    await page.getByTestId("${ids.field(identityFieldName)}").fill(unique);

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 10000 });

    // Verify the created row is present
    const createdRow = page.getByTestId("${ids.row}").filter({ hasText: unique });
    await expect(createdRow).toBeVisible({ timeout: 10000 });

    // Store the unique value for child tests to reuse
    ${varName} = unique;
  });`;

  return { varName, testStep };
}

/**
 * Generate test code for a child entity in the chain.
 * Builds linkage from ACTUAL parent relationships, not slice-order adjacency.
 * For each of the entity's parents, selects a parent that was created in an earlier test.
 * If no parents are present in earlier-created entities, generates as standalone.
 * Never throws — handles non-linear plans (branches, independent roots, different order).
 * FIX C: Uses parentVarMap to resolve parent var names by key, not by index math.
 */
function generateChildEntityChainTest(
  entity: IEntityAcceptance,
  index: number,
  spec: IAcceptanceSpec,
  createdKeys: Set<string>,
  parentVarMap: Map<string, string>
): {
  varName: string;
  testStep: string;
} {
  // Find parents whose key matches ANY entity created earlier (index < current)
  const selectableParents = entity.parents.filter((p) =>
    createdKeys.has(p.key)
  );

  // If no parents match earlier-created entities, this is an independent root or branch
  // Generate it as a standalone create (no parent selection)
  if (selectableParents.length === 0) {
    // Treat as root (no parent selection)
    const ids = testIdsFor(entity.key);
    const fieldFill = generateFieldFillSteps(entity, ids, false);

    // FIX E/FIX 3: Type-aware identity for standalone child (NOT email by type or name)
    const identityField =
      entity.fields.find((f) => {
        const fieldType = f.type.toLowerCase();
        const fieldNameLower = f.name.toLowerCase();

        return (
          (fieldType.includes("string") || fieldType.includes("text")) &&
          !fieldType.includes("email") &&
          !fieldNameLower.includes("email")
        );
      }) ?? entity.fields[0];
    const identityFieldName = identityField?.name ?? "name";
    const identityFieldValid = identityField?.valid ?? "updated";
    const firstFieldName = entity.fields[0]?.name ?? "name";
    const firstFieldValid = entity.fields[0]?.valid ?? "updated";
    const isFirstFieldIdentity = identityFieldName === firstFieldName;
    const fillFirstFieldCode = isFirstFieldIdentity
      ? ""
      : `\n    await page.getByTestId("${ids.field(firstFieldName)}").fill(${JSON.stringify(firstFieldValid)});`;

    const varName = `parent${index}Unique`;
    const testTitle = chainCreateTitle("standalone", entity.id);

    // FIX 3: If identity field is an email, build a unique email with a valid local part
    const identityFieldType = identityField?.type.toLowerCase() ?? "";
    const identityFieldNameLower = identityField?.name.toLowerCase() ?? "";
    const isIdentityEmail =
      identityFieldType.includes("email") ||
      identityFieldNameLower.includes("email");

    const uniqueValueConstruction = isIdentityEmail
      ? `(() => {
      const match = ${JSON.stringify(identityFieldValid)}.match(/^([^@]+)@(.+)$/);
      if (match) {
        const localPart = match[1];
        const domain = match[2];
        return localPart + "-" + Date.now() + "-" + Math.floor(Math.random() * 1000000) + "@" + domain;
      }
      return ${JSON.stringify(identityFieldValid)} + "-" + Date.now();
    })()`
      : `${JSON.stringify(identityFieldValid)} + "-" + Date.now() + "-" + Math.floor(Math.random() * 1000000)`;

    const testStep = `  test(${JSON.stringify(testTitle)}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    const unique = ${uniqueValueConstruction};

    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${fieldFill}${fillFirstFieldCode}
    await page.getByTestId("${ids.field(identityFieldName)}").fill(unique);

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 10000 });

    const createdRow = page.getByTestId("${ids.row}").filter({ hasText: unique });
    await expect(createdRow).toBeVisible({ timeout: 10000 });

    ${varName} = unique;
  });`;

    return { varName, testStep };
  }

  // Has parent(s) from earlier entities — resolve by key, not by index math (FIX C)
  // selectableParents is guaranteed non-empty here (checked earlier in the if above)
  const primaryParent = selectableParents[0];

  if (!primaryParent) {
    // Should never reach here due to early return above, but satisfy TS narrowing
    throw new Error("Expected at least one selectable parent");
  }

  // Generate seeding code for parents NOT in the chain (if any remain unselectable)
  const unseededParents = entity.parents.filter((p) => !createdKeys.has(p.key));
  const otherSeedingCode =
    unseededParents.length > 0
      ? generateParentSeedingCode(unseededParents, entity.id, spec)
      : "";

  // Select ALL in-chain parents (FIX C: not just [0])
  // Each selectable parent gets its resolved var name from parentVarMap
  const selectAllParentsCode = selectableParents
    .map((parent) => {
      const parentVarName = parentVarMap.get(parent.key);

      if (parentVarName === undefined || parentVarName === "") {
        // Should not reach here if map is properly populated
        throw new Error(
          `Parent ${parent.key} not found in var map when building child test`
        );
      }

      const fieldTestId = testIdsFor(entity.key).field(parent.fkField);

      return `    await page.getByTestId("${fieldTestId}").selectOption({ label: ${parentVarName} });`;
    })
    .join("\n");

  // Seed any parents that are not in the chain (use API seeding)
  const seedingSteps = unseededParents
    .map((parent) => {
      const varName = `${parent.key}Id`;
      const fieldTestId = testIdsFor(entity.key).field(parent.fkField);

      return `    await page.getByTestId("${fieldTestId}").selectOption(${varName});`;
    })
    .join("\n");

  const ids = testIdsFor(entity.key);
  const fieldFill = generateFieldFillSteps(entity, ids, true);

  // FIX E/FIX 3: Type-aware identity for child (NOT email by type or name)
  const identityField =
    entity.fields.find((f) => {
      const fieldType = f.type.toLowerCase();
      const fieldNameLower = f.name.toLowerCase();

      return (
        (fieldType.includes("string") || fieldType.includes("text")) &&
        !fieldType.includes("email") &&
        !fieldNameLower.includes("email")
      );
    }) ?? entity.fields[0];
  const identityFieldName = identityField?.name ?? "name";
  const identityFieldValid = identityField?.valid ?? "updated";
  const firstFieldName = entity.fields[0]?.name ?? "name";
  const firstFieldValid = entity.fields[0]?.valid ?? "updated";
  const isFirstFieldIdentity = identityFieldName === firstFieldName;
  const fillFirstFieldCode = isFirstFieldIdentity
    ? ""
    : `\n    await page.getByTestId("${ids.field(firstFieldName)}").fill(${JSON.stringify(firstFieldValid)});`;

  const testTitle = chainCreateTitle("child", entity.id);
  const currentVarName = `parent${index}Unique`;
  const otherParentsCode =
    otherSeedingCode.length > 0 ? `\n${otherSeedingCode}\n` : "";
  const seedingCode = seedingSteps.length > 0 ? `\n${seedingSteps}\n` : "";

  // FIX 3: If identity field is an email, build a unique email with a valid local part
  const identityFieldType = identityField?.type.toLowerCase() ?? "";
  const identityFieldNameLower = identityField?.name.toLowerCase() ?? "";
  const isIdentityEmail =
    identityFieldType.includes("email") ||
    identityFieldNameLower.includes("email");

  const uniqueValueConstruction = isIdentityEmail
    ? `(() => {
      const match = ${JSON.stringify(identityFieldValid)}.match(/^([^@]+)@(.+)$/);
      if (match) {
        const localPart = match[1];
        const domain = match[2];
        return localPart + "-child-" + Date.now() + "-" + Math.floor(Math.random() * 1000000) + "@" + domain;
      }
      return ${JSON.stringify(identityFieldValid)} + "-child-" + Date.now();
    })()`
    : `${JSON.stringify(identityFieldValid)} + "-child-" + Date.now() + "-" + Math.floor(Math.random() * 1000000)`;

  const testStep = `  test(${JSON.stringify(testTitle)}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    const unique = ${uniqueValueConstruction};

    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${fieldFill}${otherParentsCode}
    // Select all in-chain parents by display label (FIX C)
${selectAllParentsCode}${seedingCode}${fillFirstFieldCode}
    await page.getByTestId("${ids.field(identityFieldName)}").fill(unique);

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 10000 });

    const createdRow = page.getByTestId("${ids.row}").filter({ hasText: unique });
    await expect(createdRow).toBeVisible({ timeout: 10000 });

    // Assert the primary parent linkage (FIX 1: bare variable reference, not JSON-stringified)
    await expect(createdRow.getByTestId("${ids.rowCell(primaryParent.key)}")).toContainText(${(() => {
      const varName = parentVarMap.get(primaryParent.key);

      if (varName === undefined || varName === "") {
        throw new Error(
          `Parent ${primaryParent.key} not found in var map when building assertion`
        );
      }

      return varName;
    })()});

    ${currentVarName} = unique;
  });`;

  return { varName: currentVarName, testStep };
}

/**
 * Sort entities into topological order: each entity's parents (restricted to keys present in the spec)
 * must come before it. Uses a stable sort that preserves original order for entities with equal priority.
 * Cycles are broken by original order; the cycle will be detected but not cause infinite loops.
 */
function topologicalSort(entities: IEntityAcceptance[]): IEntityAcceptance[] {
  const keyToIndex = new Map(entities.map((e, i) => [e.key, i]));
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const result: IEntityAcceptance[] = [];

  function visit(entity: IEntityAcceptance): void {
    if (visited.has(entity.key)) {
      return;
    }

    if (recStack.has(entity.key)) {
      // Cycle detected; break it by using original order
      return;
    }

    recStack.add(entity.key);

    // Visit all parents that exist in the spec (those whose key is in keyToIndex)
    for (const parent of entity.parents) {
      const parentIndex = keyToIndex.get(parent.key);

      if (parentIndex !== undefined) {
        const parentEntity = entities[parentIndex];

        if (parentEntity) {
          visit(parentEntity);
        }
      }
    }

    recStack.delete(entity.key);
    visited.add(entity.key);
    result.push(entity);
  }

  for (const entity of entities) {
    visit(entity);
  }

  return result;
}

/**
 * Generate a Playwright spec that walks a full dependency chain end-to-end through the UI.
 * Creates each entity in dependency order through the UI, selecting the previously-UI-created parent.
 * Threads the parent's unique value across the chain to identify rows and assert linkage.
 *
 * Example: Company → Contact → Deal → Activity
 * - Company test: create Company via UI with unique value, store it
 * - Contact test: open Contact create form, select the Company (by its unique value from FK select),
 *   create Contact, assert Contact row shows Company linkage cell
 * - Deal test: select Contact (by its unique value), create Deal, assert Deal row shows Contact linkage
 * - Activity test: select Deal, create Activity, assert Activity row shows Deal linkage
 *
 * FIX G: Scope note — chain creates ONE entity per relational chain (end-to-end linkage smoke test).
 * Full CRUD (nav+list+create+persist+update+delete+negative) is run per-entity during the per-slice
 * acceptance phase (entity-level tests). The chain is NOT expanded to full CRUD per entity to avoid
 * test count explosion and codegen complexity. Chain = relational linkage verification only.
 *
 * FIX 2: Entities are sorted topologically before generation so that parents always precede children,
 * ensuring real linkage assertions are always emitted (never false-green from skipped linkage).
 */
export function generateChainSpec(spec: IAcceptanceSpec): string {
  if (spec.entities.length === 0) {
    return "// No entities to chain";
  }

  // FIX 2: Sort entities topologically so parents always precede children
  const sortedEntities = topologicalSort(spec.entities);

  const descTitle = `Full Relational Chain: ${sortedEntities
    .map((e) => e.id)
    .join(" → ")}`;

  // Generate nav-helpers for all entities in the chain
  const navHelpers = sortedEntities
    .map((e) => generateNavHelper(e))
    .join("\n\n");

  // Build test steps that thread the parent unique values through the chain
  // FIX C: Use a map to track entity.key → varName for resolving parents by key
  const testSteps: string[] = [];
  const parentTrackingVars: string[] = [];
  const createdKeys = new Set<string>();
  const parentVarMap = new Map<string, string>();

  for (let i = 0; i < sortedEntities.length; i++) {
    const entity = sortedEntities[i];

    if (!entity) {
      continue;
    }

    if (i === 0) {
      // Root entity
      const { varName, testStep } = generateRootEntityChainTest(
        entity,
        i,
        spec
      );

      parentTrackingVars.push(`let ${varName}: string;`);
      testSteps.push(testStep);
      createdKeys.add(entity.key);
      parentVarMap.set(entity.key, varName);
    } else {
      // Child entity — build linkage from actual parent relationships
      const { varName, testStep } = generateChildEntityChainTest(
        entity,
        i,
        spec,
        createdKeys,
        parentVarMap
      );

      parentTrackingVars.push(`let ${varName}: string;`);
      testSteps.push(testStep);
      createdKeys.add(entity.key);
      parentVarMap.set(entity.key, varName);
    }
  }

  return `import { expect, test } from "./auth-helper";

${navHelpers}

test.describe(${JSON.stringify(descTitle)}, () => {
  test.describe.configure({ mode: "serial" });

${parentTrackingVars.map((v) => `  ${v}`).join("\n")}

${testSteps.join("\n\n")}
});
`;
}

/**
 * Return the spec file path for an entity within a given cwd.
 */
export function specPath(cwd: string, key: string): string {
  return `${cwd}/apps/ui/e2e/_acceptance/${key}.spec.ts`;
}

/**
 * Return the chain spec file path for a set of entities within a given cwd.
 */
export function chainSpecPath(cwd: string): string {
  return `${cwd}/apps/ui/e2e/_acceptance/chain.spec.ts`;
}

/**
 * Generate a self-contained auth helper for acceptance specs.
 * This fixture replicates the app's auth flow but uses VITE_API_BASE
 * and PLAYWRIGHT_PORT environment variables instead of hardcoded origins.
 *
 * Handles: user registration, email verification (via force-verify endpoint),
 * and login via the page object.
 */
export function generateAuthHelper(): string {
  return `import {
  type APIRequestContext,
  test as base,
  request,
  expect,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

interface ITestUser {
  readonly email: string;
  readonly password: string;
}

interface IDashboardPage {
  goto(): Promise<void>;
}

interface ILoginPage {
  goto(): Promise<void>;
  loginAs(email: string, password: string): Promise<void>;
}

/**
 * Mock DashboardPage for isolated stack testing.
 * In production, this is loaded from pages/DashboardPage.
 */
class DashboardPage implements IDashboardPage {
  constructor(private page: import("@playwright/test").Page) {}

  async goto() {
    const uiBase = process.env.PLAYWRIGHT_HOST || "http://localhost";
    const uiPort = process.env.PLAYWRIGHT_PORT || "7331";
    const url = \`\${uiBase}:\${uiPort}/dashboard\`;
    await this.page.goto(url);
    // Use "load" to avoid hanging on background polling in modern SPAs
    await this.page.waitForLoadState("load");
  }
}

/**
 * Mock LoginPage for isolated stack testing.
 * In production, this is loaded from pages/LoginPage.
 */
class LoginPage implements ILoginPage {
  constructor(private page: import("@playwright/test").Page) {}

  async goto() {
    const uiBase = process.env.PLAYWRIGHT_HOST || "http://localhost";
    const uiPort = process.env.PLAYWRIGHT_PORT || "7331";
    const url = \`\${uiBase}:\${uiPort}/login\`;
    await this.page.goto(url);
    // Use "load" to avoid hanging on background polling in modern SPAs
    await this.page.waitForLoadState("load");
  }

  async loginAs(email: string, password: string) {
    // Fill email field (try semantic selectors first, fall back to generic)
    let emailInput = this.page.getByLabel(/email/i);
    if (await emailInput.count() === 0) {
      emailInput = this.page.locator('input[type="email"]').first();
    }
    await emailInput.fill(email);

    // Fill password field (try semantic selectors first, fall back to generic)
    let passwordInput = this.page.getByLabel(/password/i);
    if (await passwordInput.count() === 0) {
      passwordInput = this.page.locator('input[type="password"]').first();
    }
    await passwordInput.fill(password);

    // Click submit button (try semantic selectors first, fall back to generic)
    let submitButton = this.page.getByRole("button", { name: /sign in|log in/i });
    if (await submitButton.count() === 0) {
      submitButton = this.page.locator('button[type="submit"]').first();
    }
    await submitButton.click();

    // Wait for navigation (don't enforce dashboard URL, auth may redirect elsewhere)
    await this.page.waitForLoadState("load");
  }
}

const CONSENT_STORAGE_KEY = "bs.cookie-consent.v1";
// Static ISO timestamp for deterministic consent cookie (does not affect test outcomes)
const CONSENT_TIMESTAMP = "2024-01-01T00:00:00.000Z";
const CONSENT_DISMISSED_STATE = {
  state: {
    status: "configured",
    categories: { essential: true, analytics: false, marketing: false },
    configuredAt: CONSENT_TIMESTAMP,
  },
  version: 0,
};

export const test = base.extend<
  {
    login: ILoginPage;
    dashboard: IDashboardPage;
    authedPage: { login: ILoginPage; dashboard: IDashboardPage };
  },
  { testUser: ITestUser }
>({
  page: async ({ page }, use) => {
    // Set desktop viewport so sidebar is visible (hidden on mobile)
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // localStorage unavailable in restricted contexts
        }
      },
      {
        key: CONSENT_STORAGE_KEY,
        value: JSON.stringify(CONSENT_DISMISSED_STATE),
      }
    );

    await use(page);
  },
  testUser: [
    async ({}, use, workerInfo) => {
      const apiBase = process.env.VITE_API_BASE || "http://localhost:7331";
      const user: ITestUser = {
        email: \`e2e-\${String(workerInfo.workerIndex)}-\${randomUUID()}@e2e.test\`,
        password: "E2EPassword123!",
      };

      const ctx: APIRequestContext = await request.newContext({
        baseURL: apiBase,
      });

      // Register the user
      const registerRes = await ctx.post("/api/v1/auth/register", {
        data: {
          email: user.email,
          password: user.password,
          firstName: "E2E",
          lastName: "User",
        },
      });

      if (!registerRes.ok()) {
        const body = await registerRes.text();
        throw new Error(
          \`Failed to register e2e test user (HTTP \${String(registerRes.status())}): \${body}\`
        );
      }

      // Force-verify the user (test endpoint)
      const verifyRes = await ctx.post("/api/v1/auth/__test/force-verify", {
        data: { email: user.email },
      });

      if (!verifyRes.ok()) {
        const body = await verifyRes.text();
        throw new Error(
          \`Failed to force-verify e2e test user (HTTP \${String(verifyRes.status())}): \${body}\`
        );
      }

      await ctx.dispose();

      await use(user);
    },
    { scope: "worker" },
  ],
  login: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  dashboard: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
  authedPage: async ({ page, testUser }, use) => {
    const login = new LoginPage(page);
    const dashboard = new DashboardPage(page);

    await login.goto();
    await login.loginAs(testUser.email, testUser.password);
    // Auth success = we navigate AWAY from /login. Do NOT hard-wait for a
    // specific post-login route (the app may land on / or /dashboard); asserting
    // an exact target here caused false timeouts.
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
      timeout: 15000,
    });
    await use({ login, dashboard });
  },
});

export { expect };
`;
}

/**
 * Return the auth helper file path for the acceptance fixtures.
 */
export function authHelperPath(cwd: string): string {
  return `${cwd}/apps/ui/e2e/_acceptance/auth-helper.ts`;
}
