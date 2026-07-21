import { expect, test } from "./auth-helper";

async function navigateToContact(page: import("@playwright/test").Page) {
  const uiBase = process.env.PLAYWRIGHT_HOST || "http://localhost";
  const uiPort = process.env.PLAYWRIGHT_PORT || "7331";
  await page.goto(`${uiBase}:${uiPort}/contact`, { waitUntil: "domcontentloaded" });
}

test.describe("Contact", () => {
  test("navigate to contact list via sidebar", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await page.getByTestId("nav-contact").click();
    await page.waitForURL(/contact(?:\/|$)/);
    await expect(page).toHaveURL(/contact(?:\/|$)/);
  });

  test("contact list is present or empty state shown", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToContact(page);

    // Wait for either list or empty state to appear (with timeout)
    try {
      await Promise.race([
        page.getByTestId("contact-list").first().waitFor({ state: "visible", timeout: 5000 }),
        page.getByTestId("contact-empty").waitFor({ state: "visible", timeout: 5000 }),
      ]);
    } catch {
      // If neither appears, just check if they're in the DOM
      const listPresent = await page.getByTestId("contact-list").isVisible().catch(() => false);
      const emptyPresent = await page.getByTestId("contact-empty").isVisible().catch(() => false);

      if (!listPresent && !emptyPresent) {
        throw new Error("Neither list nor empty state visible after 5s");
      }
    }
  });

  test("create Contact: form fill, submit, row appears", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToContact(page);

    const initialRowCount = await page.getByTestId("contact-row").count();

    // Click create button
    await page.getByTestId("contact-create").click();
    // Wait for form to appear (form may be inline, no URL change)
    await page.getByTestId("contact-form").waitFor({ state: "visible", timeout: 5000 });

    // Seed a parent Company record
    const companyId = await (async () => {
      const res = await fetch(`${new URL(page.url()).origin}/api/v1/company`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": await page.context().cookies().then(c => c.map(x => `${x.name}=${x.value}`).join("; ")),
        },
        body: JSON.stringify({ name: `Company-for-Contact` }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Failed to seed Company (HTTP ${res.status}): ${body}`);
      }
      const data = await res.json();
      const parentId = data.id;
      if (typeof parentId !== "string") {
        throw new Error(`Seeded Company but no id in response: ${JSON.stringify(data)}`);
      }
      return parentId;
    })();

    // Fill all fields
    await page.getByTestId("contact-field-name").fill("name-2");
    await page.getByTestId("contact-field-email").fill("user2@example.com");
    await page.getByTestId("contact-field-phone").fill("phone-2");

    // Submit
    await page.getByTestId("contact-submit").click();
    // Wait for form to disappear (indicates mutation + list refresh completed)
    await page.getByTestId("contact-form").waitFor({ state: "hidden", timeout: 10000 });

    // New row should be visible with the filled values
    const finalRowCount = await page.getByTestId("contact-row").count();
    if (finalRowCount <= initialRowCount) {
      throw new Error("New Contact row did not appear after creation");
    }

    // Verify the new row contains the expected values
    await expect(page.getByTestId("contact-row-name").first()).toContainText("name-2");
    await expect(page.getByTestId("contact-row-email").first()).toContainText("user2@example.com");
    await expect(page.getByTestId("contact-row-phone").first()).toContainText("phone-2");
    await expect(page.getByTestId("contact-row-company").first()).toBeVisible();
  });

  test("Contact persists after page reload", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToContact(page);

    const initialRowCount = await page.getByTestId("contact-row").count();

    // Create a new record
    await page.getByTestId("contact-create").click();
    await page.getByTestId("contact-form").waitFor({ state: "visible", timeout: 5000 });

    // Seed a parent Company record
    const companyId = await (async () => {
      const res = await fetch(`${new URL(page.url()).origin}/api/v1/company`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": await page.context().cookies().then(c => c.map(x => `${x.name}=${x.value}`).join("; ")),
        },
        body: JSON.stringify({ name: `Company-for-Contact` }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Failed to seed Company (HTTP ${res.status}): ${body}`);
      }
      const data = await res.json();
      const parentId = data.id;
      if (typeof parentId !== "string") {
        throw new Error(`Seeded Company but no id in response: ${JSON.stringify(data)}`);
      }
      return parentId;
    })();

    await page.getByTestId("contact-field-name").fill("name-2");
    await page.getByTestId("contact-field-email").fill("user2@example.com");
    await page.getByTestId("contact-field-phone").fill("phone-2");

    await page.getByTestId("contact-submit").click();
    await page.getByTestId("contact-form").waitFor({ state: "hidden", timeout: 5000 });

    // Reload the page
    await page.reload();
    await page.waitForURL(/\/contact/);

    // Row count should still be the same (new record persisted)
    const reloadedRowCount = await page.getByTestId("contact-row").count();
    if (reloadedRowCount <= initialRowCount) {
      throw new Error("Contact did not persist after reload");
    }
  });

  test("update Contact: edit form, change field, save", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToContact(page);

    // Create a record first
    const initialRowCount = await page.getByTestId("contact-row").count();

    await page.getByTestId("contact-create").click();
    await page.getByTestId("contact-form").waitFor({ state: "visible", timeout: 5000 });

    // Seed a parent Company record
    const companyId = await (async () => {
      const res = await fetch(`${new URL(page.url()).origin}/api/v1/company`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": await page.context().cookies().then(c => c.map(x => `${x.name}=${x.value}`).join("; ")),
        },
        body: JSON.stringify({ name: `Company-for-Contact` }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Failed to seed Company (HTTP ${res.status}): ${body}`);
      }
      const data = await res.json();
      const parentId = data.id;
      if (typeof parentId !== "string") {
        throw new Error(`Seeded Company but no id in response: ${JSON.stringify(data)}`);
      }
      return parentId;
    })();

    await page.getByTestId("contact-field-name").fill("name-2");
    await page.getByTestId("contact-field-email").fill("user2@example.com");
    await page.getByTestId("contact-field-phone").fill("phone-2");

    await page.getByTestId("contact-submit").click();
    await page.getByTestId("contact-form").waitFor({ state: "hidden", timeout: 5000 });

    // Now edit the first row
    await page.getByTestId("contact-row-edit").first().click();
    await page.getByTestId("contact-form").waitFor({ state: "visible", timeout: 5000 });

    // Change a field (the first one)
    const firstField = "name";
    const updatedValue = "name-2-updated";

    await page.getByTestId("contact-field-name").clear();
    await page.getByTestId("contact-field-name").fill(updatedValue);

    await page.getByTestId("contact-submit").click();
    await page.getByTestId("contact-form").waitFor({ state: "hidden", timeout: 5000 });

    // Verify the change persists in the list
    const updatedRow = page.getByTestId("contact-row-name").first();
    await expect(updatedRow).toContainText(updatedValue);
  });

  test("delete Contact: row delete, confirm, row gone", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToContact(page);

    const initialRowCount = await page.getByTestId("contact-row").count();

    // Create a record first
    await page.getByTestId("contact-create").click();
    await page.getByTestId("contact-form").waitFor({ state: "visible", timeout: 5000 });

    // Seed a parent Company record
    const companyId = await (async () => {
      const res = await fetch(`${new URL(page.url()).origin}/api/v1/company`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": await page.context().cookies().then(c => c.map(x => `${x.name}=${x.value}`).join("; ")),
        },
        body: JSON.stringify({ name: `Company-for-Contact` }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Failed to seed Company (HTTP ${res.status}): ${body}`);
      }
      const data = await res.json();
      const parentId = data.id;
      if (typeof parentId !== "string") {
        throw new Error(`Seeded Company but no id in response: ${JSON.stringify(data)}`);
      }
      return parentId;
    })();

    await page.getByTestId("contact-field-name").fill("name-2");
    await page.getByTestId("contact-field-email").fill("user2@example.com");
    await page.getByTestId("contact-field-phone").fill("phone-2");

    await page.getByTestId("contact-submit").click();
    await page.getByTestId("contact-form").waitFor({ state: "hidden", timeout: 5000 });

    const afterCreateRowCount = await page.getByTestId("contact-row").count();

    // Delete the last row
    await page.getByTestId("contact-row-delete").last().click();

    // Confirm delete
    const confirmButton = page.getByRole("button", { name: /confirm|delete|yes/i });
    if (await confirmButton.isVisible()) {
      await confirmButton.click();
    }

    // Wait for row to disappear
    await page.waitForFunction(
      async () => {
        const count = await page.getByTestId("contact-row").count();
        return count < afterCreateRowCount;
      },
      { timeout: 5000 }
    );

    const finalRowCount = await page.getByTestId("contact-row").count();
    if (finalRowCount >= afterCreateRowCount) {
      throw new Error("Contact row was not deleted");
    }
  });

  test("negative: Contact rejects name=", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToContact(page);

    const initialRowCount = await page.getByTestId("contact-row").count();

    await page.getByTestId("contact-create").click();
    await page.waitForURL(/.*\/contact\/new/);

    // Fill form with valid values first
    await page.getByTestId("contact-field-name").fill("name-2");
    await page.getByTestId("contact-field-email").fill("user2@example.com");
    await page.getByTestId("contact-field-phone").fill("phone-2");

    // Override the target field with invalid value
    await page.getByTestId("contact-field-name").clear();
    await page.getByTestId("contact-field-name").fill("");

    await page.getByTestId("contact-submit").click();

    // Should not navigate away (form validation prevents submission)
    // and no new row should appear
    const finalRowCount = await page.getByTestId("contact-row").count();
    if (finalRowCount > initialRowCount) {
      throw new Error("Contact with invalid name should not have been created");
    }
  });

  test("negative: Contact rejects email=", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToContact(page);

    const initialRowCount = await page.getByTestId("contact-row").count();

    await page.getByTestId("contact-create").click();
    await page.waitForURL(/.*\/contact\/new/);

    // Fill form with valid values first
    await page.getByTestId("contact-field-name").fill("name-2");
    await page.getByTestId("contact-field-email").fill("user2@example.com");
    await page.getByTestId("contact-field-phone").fill("phone-2");

    // Override the target field with invalid value
    await page.getByTestId("contact-field-email").clear();
    await page.getByTestId("contact-field-email").fill("");

    await page.getByTestId("contact-submit").click();

    // Should not navigate away (form validation prevents submission)
    // and no new row should appear
    const finalRowCount = await page.getByTestId("contact-row").count();
    if (finalRowCount > initialRowCount) {
      throw new Error("Contact with invalid email should not have been created");
    }
  });

  test("negative: Contact rejects email=not-an-email", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateToContact(page);

    const initialRowCount = await page.getByTestId("contact-row").count();

    await page.getByTestId("contact-create").click();
    await page.waitForURL(/.*\/contact\/new/);

    // Fill form with valid values first
    await page.getByTestId("contact-field-name").fill("name-2");
    await page.getByTestId("contact-field-email").fill("user2@example.com");
    await page.getByTestId("contact-field-phone").fill("phone-2");

    // Override the target field with invalid value
    await page.getByTestId("contact-field-email").clear();
    await page.getByTestId("contact-field-email").fill("not-an-email");

    await page.getByTestId("contact-submit").click();

    // Should not navigate away (form validation prevents submission)
    // and no new row should appear
    const finalRowCount = await page.getByTestId("contact-row").count();
    if (finalRowCount > initialRowCount) {
      throw new Error("Contact with invalid email should not have been created");
    }
  });

});
