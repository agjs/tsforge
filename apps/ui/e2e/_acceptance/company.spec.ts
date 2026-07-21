import { expect, test } from "./auth-helper";

async function navigateToCompany(page: import("@playwright/test").Page) {
  const uiBase = process.env.PLAYWRIGHT_HOST || "http://localhost";
  const uiPort = process.env.PLAYWRIGHT_PORT || "7331";
  await page.goto(`${uiBase}:${uiPort}/company`, { waitUntil: "domcontentloaded" });
}

test.describe("Company", () => {
  test("navigate to company list via sidebar", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await page.getByTestId("nav-company").click();
    await page.waitForURL(/company(?:\/|$)/);
    await expect(page).toHaveURL(/company(?:\/|$)/);
  });

  test("company list is present or empty state shown", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToCompany(page);

    // Wait for either list or empty state to appear (with timeout)
    try {
      await Promise.race([
        page.getByTestId("company-list").first().waitFor({ state: "visible", timeout: 5000 }),
        page.getByTestId("company-empty").waitFor({ state: "visible", timeout: 5000 }),
      ]);
    } catch {
      // If neither appears, just check if they're in the DOM
      const listPresent = await page.getByTestId("company-list").isVisible().catch(() => false);
      const emptyPresent = await page.getByTestId("company-empty").isVisible().catch(() => false);

      if (!listPresent && !emptyPresent) {
        throw new Error("Neither list nor empty state visible after 5s");
      }
    }
  });

  test("create Company: form fill, submit, row appears", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToCompany(page);

    const initialRowCount = await page.getByTestId("company-row").count();

    // Click create button
    await page.getByTestId("company-create").click();
    // Wait for form to appear (form may be inline, no URL change)
    await page.getByTestId("company-form").waitFor({ state: "visible", timeout: 5000 });



    // Fill all fields
    await page.getByTestId("company-field-name").fill("name-1");
    await page.getByTestId("company-field-industry").fill("industry-1");
    await page.getByTestId("company-field-website").fill("https://example1.com");

    // Submit
    await page.getByTestId("company-submit").click();
    // Wait for form to disappear (indicates mutation + list refresh completed)
    await page.getByTestId("company-form").waitFor({ state: "hidden", timeout: 10000 });

    // New row should be visible with the filled values
    const finalRowCount = await page.getByTestId("company-row").count();
    if (finalRowCount <= initialRowCount) {
      throw new Error("New Company row did not appear after creation");
    }

    // Verify the new row contains the expected values
    await expect(page.getByTestId("company-row-name").first()).toContainText("name-1");
    await expect(page.getByTestId("company-row-industry").first()).toContainText("industry-1");
    await expect(page.getByTestId("company-row-website").first()).toContainText("https://example1.com");
  });

  test("Company persists after page reload", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToCompany(page);

    const initialRowCount = await page.getByTestId("company-row").count();

    // Create a new record
    await page.getByTestId("company-create").click();
    await page.getByTestId("company-form").waitFor({ state: "visible", timeout: 5000 });



    await page.getByTestId("company-field-name").fill("name-1");
    await page.getByTestId("company-field-industry").fill("industry-1");
    await page.getByTestId("company-field-website").fill("https://example1.com");

    await page.getByTestId("company-submit").click();
    await page.getByTestId("company-form").waitFor({ state: "hidden", timeout: 5000 });

    // Reload the page
    await page.reload();
    await page.waitForURL(/\/company/);

    // Row count should still be the same (new record persisted)
    const reloadedRowCount = await page.getByTestId("company-row").count();
    if (reloadedRowCount <= initialRowCount) {
      throw new Error("Company did not persist after reload");
    }
  });

  test("update Company: edit form, change field, save", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToCompany(page);

    // Create a record first
    const initialRowCount = await page.getByTestId("company-row").count();

    await page.getByTestId("company-create").click();
    await page.getByTestId("company-form").waitFor({ state: "visible", timeout: 5000 });



    await page.getByTestId("company-field-name").fill("name-1");
    await page.getByTestId("company-field-industry").fill("industry-1");
    await page.getByTestId("company-field-website").fill("https://example1.com");

    await page.getByTestId("company-submit").click();
    await page.getByTestId("company-form").waitFor({ state: "hidden", timeout: 5000 });

    // Now edit the first row
    await page.getByTestId("company-row-edit").first().click();
    await page.getByTestId("company-form").waitFor({ state: "visible", timeout: 5000 });

    // Change a field (the first one)
    const firstField = "name";
    const updatedValue = "name-1-updated";

    await page.getByTestId("company-field-name").clear();
    await page.getByTestId("company-field-name").fill(updatedValue);

    await page.getByTestId("company-submit").click();
    await page.getByTestId("company-form").waitFor({ state: "hidden", timeout: 5000 });

    // Verify the change persists in the list
    const updatedRow = page.getByTestId("company-row-name").first();
    await expect(updatedRow).toContainText(updatedValue);
  });

  test("delete Company: row delete, confirm, row gone", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToCompany(page);

    const initialRowCount = await page.getByTestId("company-row").count();

    // Create a record first
    await page.getByTestId("company-create").click();
    await page.getByTestId("company-form").waitFor({ state: "visible", timeout: 5000 });



    await page.getByTestId("company-field-name").fill("name-1");
    await page.getByTestId("company-field-industry").fill("industry-1");
    await page.getByTestId("company-field-website").fill("https://example1.com");

    await page.getByTestId("company-submit").click();
    await page.getByTestId("company-form").waitFor({ state: "hidden", timeout: 5000 });

    const afterCreateRowCount = await page.getByTestId("company-row").count();

    // Delete the last row
    await page.getByTestId("company-row-delete").last().click();

    // Confirm delete
    const confirmButton = page.getByRole("button", { name: /confirm|delete|yes/i });
    if (await confirmButton.isVisible()) {
      await confirmButton.click();
    }

    // Wait for row to disappear
    await page.waitForFunction(
      async () => {
        const count = await page.getByTestId("company-row").count();
        return count < afterCreateRowCount;
      },
      { timeout: 5000 }
    );

    const finalRowCount = await page.getByTestId("company-row").count();
    if (finalRowCount >= afterCreateRowCount) {
      throw new Error("Company row was not deleted");
    }
  });

  test("negative: Company rejects name=", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToCompany(page);

    const initialRowCount = await page.getByTestId("company-row").count();

    await page.getByTestId("company-create").click();
    await page.waitForURL(/.*\/company\/new/);

    // Fill form with valid values first
    await page.getByTestId("company-field-name").fill("name-1");
    await page.getByTestId("company-field-industry").fill("industry-1");
    await page.getByTestId("company-field-website").fill("https://example1.com");

    // Override the target field with invalid value
    await page.getByTestId("company-field-name").clear();
    await page.getByTestId("company-field-name").fill("");

    await page.getByTestId("company-submit").click();

    // Should not navigate away (form validation prevents submission)
    // and no new row should appear
    const finalRowCount = await page.getByTestId("company-row").count();
    if (finalRowCount > initialRowCount) {
      throw new Error("Company with invalid name should not have been created");
    }
  });

});
