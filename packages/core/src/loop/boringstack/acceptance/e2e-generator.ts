import type { IEntityAcceptance } from "../../acceptance/acceptance.types";
import { testIdsFor } from "../../acceptance/acceptance-spec";

/**
 * Generate a Playwright spec text for a single entity's CRUD operations.
 * Returns a `.spec.ts` string ready to write to disk.
 *
 * Covers: nav, list (or empty), create, persist (reload), update, delete, and negative cases.
 * Uses the app's authedPage fixture and getByTestId selectors.
 *
 * No relationship logic yet (Task 6 adds parent-select + linkage).
 */
export function generateEntitySpec(entity: IEntityAcceptance): string {
  const ids = testIdsFor(entity.key);
  const name = entity.id;

  // Render field fill steps for create/update
  const fieldFillSteps = entity.fields
    .map(
      (field) =>
        `    await page.getByTestId("${ids.field(field.name)}").fill("${field.valid}");`
    )
    .join("\n");

  // Render show field assertions (list row cells)
  const rowCellAssertions = entity.shows
    .map(
      (show) =>
        `    await expect(page.getByTestId("${ids.rowCell(show)}").first()).toContainText("${
          entity.fields.find((f) => f.name === show)?.valid ?? show
        }");`
    )
    .join("\n");

  // Render negative test blocks
  const negativeBlocks = entity.negatives
    .map((neg) => {
      const fieldTestId = ids.field(neg.field);
      const invalidValue = neg.value;

      return `  test("negative: ${name} rejects ${neg.field}=${invalidValue}", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await page.getByTestId("${ids.nav}").click();
    await page.waitForURL(/\\/${entity.key}/);

    const initialRowCount = await page.getByTestId("${ids.row}").count();

    await page.getByTestId("${ids.create}").click();
    await page.waitForURL(/.*\\/${entity.key}\\/new/);

    // Fill form with valid values first
${fieldFillSteps}

    // Override the target field with invalid value
    await page.getByTestId("${fieldTestId}").clear();
    await page.getByTestId("${fieldTestId}").fill("${invalidValue}");

    await page.getByTestId("${ids.submit}").click();

    // Should not navigate away (form validation prevents submission)
    // and no new row should appear
    const finalRowCount = await page.getByTestId("${ids.row}").count();
    if (finalRowCount > initialRowCount) {
      throw new Error("${name} with invalid ${neg.field} should not have been created");
    }
  });
`;
    })
    .join("\n");

  return `import { expect, test } from "../fixtures/auth";

test.describe("${name}", () => {
  test("navigate to ${entity.key} list via sidebar", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await page.getByTestId("${ids.nav}").click();
    await page.waitForURL(/\\/${entity.key}/);
    await expect(page).toHaveURL(/\\/${entity.key}/);
  });

  test("${entity.key} list is present or empty state shown", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await page.getByTestId("${ids.nav}").click();
    await page.waitForURL(/\\/${entity.key}/);

    const listPresent = await page.getByTestId("${ids.list}").isVisible();
    const emptyPresent = await page.getByTestId("${ids.empty}").isVisible();

    if (!listPresent && !emptyPresent) {
      throw new Error("Neither list nor empty state visible");
    }
  });

  test("create ${name}: form fill, submit, row appears", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await page.getByTestId("${ids.nav}").click();
    await page.waitForURL(/\\/${entity.key}/);

    const initialRowCount = await page.getByTestId("${ids.row}").count();

    // Click create button
    await page.getByTestId("${ids.create}").click();
    await page.waitForURL(/.*\\/${entity.key}\\/new/);

    // Fill all fields
${fieldFillSteps}

    // Submit
    await page.getByTestId("${ids.submit}").click();

    // Should navigate back to list
    await page.waitForURL(/\\/${entity.key}(?:\\/|$)/);

    // New row should be visible with the filled values
    const finalRowCount = await page.getByTestId("${ids.row}").count();
    if (finalRowCount <= initialRowCount) {
      throw new Error("New ${name} row did not appear after creation");
    }

    // Verify the new row contains the expected values
${rowCellAssertions}
  });

  test("${name} persists after page reload", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await page.getByTestId("${ids.nav}").click();
    await page.waitForURL(/\\/${entity.key}/);

    const initialRowCount = await page.getByTestId("${ids.row}").count();

    // Create a new record
    await page.getByTestId("${ids.create}").click();
    await page.waitForURL(/.*\\/${entity.key}\\/new/);

${fieldFillSteps}

    await page.getByTestId("${ids.submit}").click();
    await page.waitForURL(/\\/${entity.key}(?:\\/|$)/);

    // Reload the page
    await page.reload();
    await page.waitForURL(/\\/${entity.key}/);

    // Row count should still be the same (new record persisted)
    const reloadedRowCount = await page.getByTestId("${ids.row}").count();
    if (reloadedRowCount <= initialRowCount) {
      throw new Error("${name} did not persist after reload");
    }
  });

  test("update ${name}: edit form, change field, save", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await page.getByTestId("${ids.nav}").click();
    await page.waitForURL(/\\/${entity.key}/);

    // Create a record first
    const initialRowCount = await page.getByTestId("${ids.row}").count();

    await page.getByTestId("${ids.create}").click();
    await page.waitForURL(/.*\\/${entity.key}\\/new/);

${fieldFillSteps}

    await page.getByTestId("${ids.submit}").click();
    await page.waitForURL(/\\/${entity.key}(?:\\/|$)/);

    // Now edit the first row
    await page.getByTestId("${ids.rowEdit}").first().click();
    await page.waitForURL(/.*\\/${entity.key}\\/.*\\/(edit|update)/);

    // Change a field (the first one)
    const firstField = "${entity.fields[0]?.name ?? "name"}";
    const updatedValue = "${entity.fields[0]?.valid ?? "updated"}-updated";

    await page.getByTestId("${ids.field(entity.fields[0]?.name ?? "name")}").clear();
    await page.getByTestId("${ids.field(entity.fields[0]?.name ?? "name")}").fill(updatedValue);

    await page.getByTestId("${ids.submit}").click();
    await page.waitForURL(/\\/${entity.key}(?:\\/|$)/);

    // Verify the change persists in the list
    const updatedRow = page.getByTestId("${ids.rowCell(entity.shows[0] ?? entity.fields[0]?.name ?? "name")}").first();
    await expect(updatedRow).toContainText(updatedValue);
  });

  test("delete ${name}: row delete, confirm, row gone", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await page.getByTestId("${ids.nav}").click();
    await page.waitForURL(/\\/${entity.key}/);

    const initialRowCount = await page.getByTestId("${ids.row}").count();

    // Create a record first
    await page.getByTestId("${ids.create}").click();
    await page.waitForURL(/.*\\/${entity.key}\\/new/);

${fieldFillSteps}

    await page.getByTestId("${ids.submit}").click();
    await page.waitForURL(/\\/${entity.key}(?:\\/|$)/);

    const afterCreateRowCount = await page.getByTestId("${ids.row}").count();

    // Delete the last row
    await page.getByTestId("${ids.rowDelete}").last().click();

    // Confirm delete
    const confirmButton = page.getByRole("button", { name: /confirm|delete|yes/i });
    if (await confirmButton.isVisible()) {
      await confirmButton.click();
    }

    // Wait for row to disappear
    await page.waitForFunction(
      async () => {
        const count = await page.getByTestId("${ids.row}").count();
        return count < afterCreateRowCount;
      },
      { timeout: 5000 }
    );

    const finalRowCount = await page.getByTestId("${ids.row}").count();
    if (finalRowCount >= afterCreateRowCount) {
      throw new Error("${name} row was not deleted");
    }
  });

${negativeBlocks}
});
`;
}

/**
 * Return the spec file path for an entity within a given cwd.
 */
export function specPath(cwd: string, key: string): string {
  return `${cwd}/apps/ui/e2e/_acceptance/${key}.spec.ts`;
}
