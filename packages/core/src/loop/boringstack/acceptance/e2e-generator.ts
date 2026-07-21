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
    case "relationship":
      return "relationship";
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
 * Generate field fill steps for form inputs.
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

      return `    await page.getByTestId("${ids.field(field.name)}").fill(${JSON.stringify(field.valid)});`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Generate row cell assertions for created values.
 * For parent references, assert the linkage cell contains the parent entity's name
 * (not just visibility — ensures the relationship is actually displayed).
 * For regular fields, assert cell contains the expected value.
 * Safely interpolates field values using JSON.stringify.
 */
function generateRowCellAssertions(
  entity: IEntityAcceptance,
  ids: ReturnType<typeof testIdsFor>
): string {
  return entity.shows
    .map((show) => {
      // Check if this show is a parent reference
      const isParent = entity.parents.some((p) => p.key === show);

      if (isParent) {
        // For parent references, assert the cell contains CONTENT related to the parent
        // (e.g., the parent's name/display value), not just visibility.
        // This ensures the relationship is actually displayed and not an empty cell with the right testid.
        const parentDef = entity.parents.find((p) => p.key === show);

        if (parentDef) {
          // The parent's entity name is what we expect to see in the display
          // E.g., a Contact's company cell should display the company's name field value
          return `    await expect(row.getByTestId("${ids.rowCell(show)}")).toContainText(${JSON.stringify(parentDef.entity)});`;
        }

        // Fallback (should not reach here)
        return `    await expect(row.getByTestId("${ids.rowCell(show)}")).toBeVisible();`;
      }

      // For regular fields, assert the value is present in THIS row only
      const value = entity.fields.find((f) => f.name === show)?.valid ?? show;

      return `    await expect(row.getByTestId("${ids.rowCell(show)}")).toContainText(${JSON.stringify(value)});`;
    })
    .join("\n");
}

/**
 * Generate negative test blocks.
 * Safely interpolates field names, invalid values, and entity name using JSON.stringify.
 *
 * Negatives work by:
 * 1. Record initial row count before creating the form
 * 2. Open create form and emit parentSeedingCode (so FK variables are declared)
 * 3. Fill all fields validly
 * 4. Override ONLY the target field with invalid value
 * 5. Submit and reload
 * 6. Assert row count did NOT increase — the invalid record was rejected and not persisted
 *
 * This approach is robust: it doesn't depend on visible error elements and reliably
 * distinguishes API rejection from form validation failures.
 */
function generateNegativeBlocks(
  entity: IEntityAcceptance,
  ids: ReturnType<typeof testIdsFor>,
  fieldFillSteps: string,
  parentSeedingCode: string
): string {
  return entity.negatives
    .map((neg) => {
      const fieldTestId = ids.field(neg.field);
      const testTitle = `negative: ${entity.id} rejects ${neg.field}=${neg.value}`;

      return `  test(${JSON.stringify(testTitle)}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    // Record initial row count before attempting to create an invalid record
    const rowsBefore = await page.getByTestId("${ids.row}").count();

    // Open create form
    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

    // Emit parent seeding code so FK variables (e.g., companyId) are declared
${parentSeedingCode}

    // Fill all fields with valid values
${fieldFillSteps}

    // Override the target field with the invalid value (clear first, then fill)
    await page.getByTestId("${fieldTestId}").clear();
    await page.getByTestId("${fieldTestId}").fill(${JSON.stringify(neg.value)});

    // Submit with invalid input
    await page.getByTestId("${ids.submit}").click();

    // Reload to ensure the invalid record would persist if accepted by the backend
    await page.reload();
    await page.waitForURL(/\\/${entity.key}/);

    // Assert: the row count did NOT increase — the invalid record was rejected
    const rowsAfter = await page.getByTestId("${ids.row}").count();
    await expect(rowsAfter).toBe(rowsBefore, { timeout: 5000 });
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
  const rowCellAssertions = generateRowCellAssertions(entity, ids);
  const parentSeedingCode = generateParentSeedingCode(
    entity.parents,
    entity.id,
    spec
  );
  const negativeBlocks = generateNegativeBlocks(
    entity,
    ids,
    fieldFillSteps,
    parentSeedingCode
  );

  // FIX 6: Type-aware unique identity value
  // Find the first field with a string-like type for the unique marker
  const stringTypePatterns = ["string", "text", "email"];
  const identityField =
    entity.fields.find((f) =>
      stringTypePatterns.some((type) => f.type.toLowerCase().includes(type))
    ) ?? entity.fields[0];
  const identityFieldName = identityField?.name ?? "name";
  const identityFieldValid = identityField?.valid ?? "updated";
  const firstFieldName = entity.fields[0]?.name ?? "name";
  const firstFieldValid = entity.fields[0]?.valid ?? "updated";

  // Determine if we need to fill the first field separately from the identity field
  const isFirstFieldIdentity = identityFieldName === firstFieldName;
  const fillFirstFieldCode = isFirstFieldIdentity
    ? ""
    : `    await page.getByTestId("${ids.field(firstFieldName)}").fill(${JSON.stringify(firstFieldValid)});\n`;

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
    const unique =
      ${JSON.stringify(identityFieldValid)} + "-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);

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

    const unique =
      ${JSON.stringify(identityFieldValid)} + "-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);

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
    await expect(
      page.getByTestId("${ids.row}").filter({ hasText: unique })
    ).toBeVisible({ timeout: 10000 });
  });

  test(${JSON.stringify(stepTitle("update", entity.key, name))}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    // Create a record stamped with a unique value (identity field, not first field)
    const unique =
      ${JSON.stringify(identityFieldValid)} + "-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);
    const updatedValue = unique + "-updated";

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

    const unique =
      ${JSON.stringify(identityFieldValid)} + "-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);

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

  // FIX 6: Type-aware identity for chain tests
  const stringTypePatterns = ["string", "text", "email"];
  const identityField =
    entity.fields.find((f) =>
      stringTypePatterns.some((type) => f.type.toLowerCase().includes(type))
    ) ?? entity.fields[0];
  const identityFieldName = identityField?.name ?? "name";
  const identityFieldValid = identityField?.valid ?? "updated";
  const firstFieldName = entity.fields[0]?.name ?? "name";
  const firstFieldValid = entity.fields[0]?.valid ?? "updated";
  const isFirstFieldIdentity = identityFieldName === firstFieldName;
  const fillFirstFieldCode = isFirstFieldIdentity
    ? ""
    : `\n    await page.getByTestId("${ids.field(firstFieldName)}").fill(${JSON.stringify(firstFieldValid)});`;
  const varName = `parent${index}Unique`;

  const testStep = `  test("create root entity: ${entity.id}", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    // Create unique root entity identifier
    const unique =
      ${JSON.stringify(identityFieldValid)} + "-root-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);

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
 */
function generateChildEntityChainTest(
  entity: IEntityAcceptance,
  index: number,
  spec: IAcceptanceSpec
): {
  varName: string;
  testStep: string;
} {
  const predecessorEntity = spec.entities[index - 1];

  if (!predecessorEntity) {
    throw new Error(
      `Child entity at index ${index} has no predecessor. Chain must be sequential.`
    );
  }

  // Find the parent FK that matches the chain predecessor (by key)
  const predecessorFK = entity.parents.find(
    (p) => p.key === predecessorEntity.key
  );

  if (!predecessorFK) {
    throw new Error(
      `Entity '${entity.id}' must have a parent FK to its chain predecessor '${predecessorEntity.id}'. ` +
        `For multi-parent entities, the predecessor must be one of the required parents.`
    );
  }

  // Separate the predecessor FK from other required parents
  const otherParents = entity.parents.filter(
    (p) => p.key !== predecessorEntity.key
  );

  // Generate seeding code for other parents (via API)
  const otherSeedingCode =
    otherParents.length > 0
      ? generateParentSeedingCode(otherParents, entity.id, spec)
      : "";

  // Generate selectOption statements for other parents
  const otherSelectSteps = otherParents
    .map((parent) => {
      const ids = testIdsFor(entity.key);
      const fieldTestId = ids.field(parent.fkField);
      const varName = `${parent.key}Id`;

      return `    await page.getByTestId("${fieldTestId}").selectOption(${varName});`;
    })
    .join("\n");

  const ids = testIdsFor(entity.key);
  const fieldFill = generateFieldFillSteps(entity, ids, true);

  // FIX 6: Type-aware identity for child chain tests
  const stringTypePatterns = ["string", "text", "email"];
  const identityField =
    entity.fields.find((f) =>
      stringTypePatterns.some((type) => f.type.toLowerCase().includes(type))
    ) ?? entity.fields[0];
  const identityFieldName = identityField?.name ?? "name";
  const identityFieldValid = identityField?.valid ?? "updated";
  const firstFieldName = entity.fields[0]?.name ?? "name";
  const firstFieldValid = entity.fields[0]?.valid ?? "updated";
  const isFirstFieldIdentity = identityFieldName === firstFieldName;
  const fillFirstFieldCode = isFirstFieldIdentity
    ? ""
    : `\n    await page.getByTestId("${ids.field(firstFieldName)}").fill(${JSON.stringify(firstFieldValid)});`;

  const parentVarName = `parent${index - 1}Unique`;
  const currentVarName = `parent${index}Unique`;
  const predecessorFieldTestId = ids.field(predecessorFK.fkField);
  const otherParentsCode =
    otherSeedingCode.length > 0 ? `\n${otherSeedingCode}\n` : "";
  const otherSelectCode =
    otherSelectSteps.length > 0 ? `\n${otherSelectSteps}\n` : "";

  const testStep = `  test("create child entity: ${entity.id} with parent linkage", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    // Create unique child entity identifier
    const unique =
      ${JSON.stringify(identityFieldValid)} + "-child-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);

    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${fieldFill}${otherParentsCode}
    // Select the chain predecessor by its display label (created in previous test)
    // FK option values are IDs; the label is the display text (parentVarName)
    await page.getByTestId("${predecessorFieldTestId}").selectOption({ label: ${parentVarName} });${otherSelectCode}${fillFirstFieldCode}
    await page.getByTestId("${ids.field(identityFieldName)}").fill(unique);

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 10000 });

    // Verify the created child row is present
    const createdRow = page.getByTestId("${ids.row}").filter({ hasText: unique });
    await expect(createdRow).toBeVisible({ timeout: 10000 });

    // Verify the predecessor parent linkage cell is present in this child row
    await expect(createdRow.getByTestId("${ids.rowCell(predecessorFK.key)}")).toContainText(${parentVarName});

    // Store the unique value for subsequent child tests
    ${currentVarName} = unique;
  });`;

  return { varName: currentVarName, testStep };
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
 */
export function generateChainSpec(spec: IAcceptanceSpec): string {
  if (spec.entities.length === 0) {
    return "// No entities to chain";
  }

  const descTitle = `Full Relational Chain: ${spec.entities
    .map((e) => e.id)
    .join(" → ")}`;

  // Generate nav-helpers for all entities in the chain
  const navHelpers = spec.entities
    .map((e) => generateNavHelper(e))
    .join("\n\n");

  // Build test steps that thread the parent unique values through the chain
  const testSteps: string[] = [];
  const parentTrackingVars: string[] = [];

  for (let i = 0; i < spec.entities.length; i++) {
    const entity = spec.entities[i];

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
    } else {
      // Child entity
      const { varName, testStep } = generateChildEntityChainTest(
        entity,
        i,
        spec
      );

      parentTrackingVars.push(`let ${varName}: string;`);
      testSteps.push(testStep);
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
const CONSENT_DISMISSED_STATE = {
  state: {
    status: "configured",
    categories: { essential: true, analytics: false, marketing: false },
    configuredAt: new Date().toISOString(),
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
