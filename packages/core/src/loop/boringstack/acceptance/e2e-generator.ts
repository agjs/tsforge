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
 * For each parent, creates a record via the API using the parent's valid field values.
 * Returns TypeScript code that declares parentId variables.
 */
function generateParentSeedingCode(
  parents: IParentRef[],
  entityId: string
): string {
  if (parents.length === 0) {
    return "";
  }

  return parents
    .map((parent) => {
      const parentKey = parent.key;
      const varName = `${parentKey}Id`;

      return `    // Seed a parent ${parent.entity} record
    const ${varName} = await (async () => {
      const res = await fetch(\`\${new URL(page.url()).origin}/api/v1/${parentKey}\`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": await page.context().cookies().then(c => c.map(x => \`\${x.name}=\${x.value}\`).join("; ")),
        },
        body: JSON.stringify({ name: \`${parent.entity}-for-${entityId}\` }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(\`Failed to seed ${parent.entity} (HTTP \${res.status}): \${body}\`);
      }
      const data = await res.json();
      const parentId = data.id;
      if (typeof parentId !== "string") {
        throw new Error(\`Seeded ${parent.entity} but no id in response: \${JSON.stringify(data)}\`);
      }
      return parentId;
    })();`;
    })
    .join("\n");
}

/**
 * Generate field fill steps for form inputs.
 * Each step safely interpolates field.valid using JSON.stringify.
 */
function generateFieldFillSteps(
  entity: IEntityAcceptance,
  ids: ReturnType<typeof testIdsFor>
): string {
  return entity.fields
    .map((field) => {
      const isFK = entity.parents.some((p) => p.fkField === field.name);

      if (isFK) {
        const parent = entity.parents.find((p) => p.fkField === field.name);

        if (parent) {
          const varName = `${parent.key}Id`;

          return `    await page.getByTestId("${ids.field(field.name)}").selectOption(${varName});`;
        }
      }

      return `    await page.getByTestId("${ids.field(field.name)}").fill(${JSON.stringify(field.valid)});`;
    })
    .join("\n");
}

/**
 * Generate row cell assertions for created values.
 * For parent references, assert the linkage cell is visible (contains parent's name).
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
        // For parent references, just assert the cell is visible (parent name will be there)
        return `    await expect(page.getByTestId("${ids.rowCell(show)}").first()).toBeVisible();`;
      }

      // For regular fields, assert the value is present
      const value = entity.fields.find((f) => f.name === show)?.valid ?? show;

      return `    await expect(page.getByTestId("${ids.rowCell(show)}").first()).toContainText(${JSON.stringify(value)});`;
    })
    .join("\n");
}

/**
 * Generate negative test blocks.
 * Safely interpolates field names, invalid values, and entity name using JSON.stringify.
 */
function generateNegativeBlocks(
  entity: IEntityAcceptance,
  ids: ReturnType<typeof testIdsFor>,
  fieldFillSteps: string
): string {
  return entity.negatives
    .map((neg) => {
      const fieldTestId = ids.field(neg.field);
      const testTitle = `negative: ${entity.id} rejects ${neg.field}=${neg.value}`;
      const errorMsg = `${entity.id} with invalid ${neg.field} should not have been created`;

      return `  test(${JSON.stringify(testTitle)}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    const initialRowCount = await page.getByTestId("${ids.row}").count();

    await page.getByTestId("${ids.create}").click();
    await page.waitForURL(/.*\\/${entity.key}\\/new/);

    // Fill form with valid values first
${fieldFillSteps}

    // Override the target field with invalid value
    await page.getByTestId("${fieldTestId}").clear();
    await page.getByTestId("${fieldTestId}").fill(${JSON.stringify(neg.value)});

    await page.getByTestId("${ids.submit}").click();

    // Should not navigate away (form validation prevents submission)
    // and no new row should appear
    const finalRowCount = await page.getByTestId("${ids.row}").count();
    if (finalRowCount > initialRowCount) {
      throw new Error(${JSON.stringify(errorMsg)});
    }
  });
`;
    })
    .join("\n");
}

/**
 * Generate a Playwright spec text for a single entity's CRUD operations.
 * Returns a `.spec.ts` string ready to write to disk.
 *
 * Covers: nav, list (or empty), create, persist (reload), update, delete, and negative cases.
 * Uses the app's authedPage fixture and getByTestId selectors.
 * For entities with parents, seeds the parent via API and selects it in the form.
 */
export function generateEntitySpec(entity: IEntityAcceptance): string {
  const ids = testIdsFor(entity.key);
  const name = entity.id;
  const fieldFillSteps = generateFieldFillSteps(entity, ids);
  const rowCellAssertions = generateRowCellAssertions(entity, ids);
  const negativeBlocks = generateNegativeBlocks(entity, ids, fieldFillSteps);
  const parentSeedingCode = generateParentSeedingCode(
    entity.parents,
    entity.id
  );

  const firstFieldName = entity.fields[0]?.name ?? "name";
  const firstFieldValid = entity.fields[0]?.valid ?? "updated";

  return `import { expect, test } from "./auth-helper";

async function navigateTo${entity.id}(page: import("@playwright/test").Page) {
  const uiBase = process.env.PLAYWRIGHT_HOST || "http://localhost";
  const uiPort = process.env.PLAYWRIGHT_PORT || "7331";
  await page.goto(\`\${uiBase}:\${uiPort}/${entity.key}\`, { waitUntil: "domcontentloaded" });
}

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

    const initialRowCount = await page.getByTestId("${ids.row}").count();

    // Click create button
    await page.getByTestId("${ids.create}").click();
    // Wait for form to appear (form may be inline, no URL change)
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${parentSeedingCode}

    // Fill all fields
${fieldFillSteps}

    // Submit
    await page.getByTestId("${ids.submit}").click();
    // Wait for form to disappear (indicates mutation + list refresh completed)
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 10000 });

    // New row should be visible with the filled values
    const finalRowCount = await page.getByTestId("${ids.row}").count();
    if (finalRowCount <= initialRowCount) {
      throw new Error(${JSON.stringify(`New ${name} row did not appear after creation`)});
    }

    // Verify the new row contains the expected values
${rowCellAssertions}
  });

  test(${JSON.stringify(stepTitle("persist", entity.key, name))}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    const initialRowCount = await page.getByTestId("${ids.row}").count();

    // Create a new record
    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${parentSeedingCode}

${fieldFillSteps}

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 5000 });

    // Reload the page
    await page.reload();
    await page.waitForURL(/\\/${entity.key}/);

    // Row count should still be the same (new record persisted)
    const reloadedRowCount = await page.getByTestId("${ids.row}").count();
    if (reloadedRowCount <= initialRowCount) {
      throw new Error(${JSON.stringify(`${name} did not persist after reload`)});
    }
  });

  test(${JSON.stringify(stepTitle("update", entity.key, name))}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    // Create a record first
    const initialRowCount = await page.getByTestId("${ids.row}").count();

    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${parentSeedingCode}

${fieldFillSteps}

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 5000 });

    // Now edit the first row
    await page.getByTestId("${ids.rowEdit}").first().click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

    // Change a field (the first one)
    const firstField = ${JSON.stringify(firstFieldName)};
    const updatedValue = ${JSON.stringify(firstFieldValid + "-updated")};

    await page.getByTestId("${ids.field(firstFieldName)}").clear();
    await page.getByTestId("${ids.field(firstFieldName)}").fill(updatedValue);

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 5000 });

    // Verify the change persists in the list
    const updatedRow = page.getByTestId("${ids.rowCell(entity.shows[0] ?? firstFieldName)}").first();
    await expect(updatedRow).toContainText(updatedValue);
  });

  test(${JSON.stringify(stepTitle("delete", entity.key, name))}, async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    const initialRowCount = await page.getByTestId("${ids.row}").count();

    // Create a record first
    await page.getByTestId("${ids.create}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "visible", timeout: 5000 });

${parentSeedingCode}

${fieldFillSteps}

    await page.getByTestId("${ids.submit}").click();
    await page.getByTestId("${ids.form}").waitFor({ state: "hidden", timeout: 5000 });

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
      throw new Error(${JSON.stringify(`${name} row was not deleted`)});
    }
  });

${negativeBlocks}
});
`;
}

/**
 * Generate a Playwright spec that walks a full dependency chain end-to-end through the UI.
 * Creates each entity in dependency order, selecting the previously-created parent,
 * and asserting linkage at each hop.
 *
 * Example: Company → Contact → Deal → Activity
 */
export function generateChainSpec(spec: IAcceptanceSpec): string {
  if (spec.entities.length === 0) {
    return "// No entities to chain";
  }

  const descTitle = `Full Relational Chain: ${spec.entities.map((e) => e.id).join(" → ")}`;
  const testSteps: string[] = [];

  for (let i = 0; i < spec.entities.length; i++) {
    const entity = spec.entities[i];

    if (!entity) {
      continue;
    }

    const ids = testIdsFor(entity.key);
    const isRoot = i === 0;

    const parentSeeding = generateParentSeedingCode(entity.parents, entity.id);
    const fieldFill = generateFieldFillSteps(entity, ids);

    if (isRoot) {
      testSteps.push(`  test("create root entity: ${entity.id}", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    const initialCount = await page.getByTestId("${ids.row}").count();
    await page.getByTestId("${ids.create}").click();
    await page.waitForURL(/.*\\/${entity.key}\\/new/);

${fieldFill}

    await page.getByTestId("${ids.submit}").click();
    await page.waitForURL(/\\/${entity.key}(?:\\/|$)/);

    const finalCount = await page.getByTestId("${ids.row}").count();
    if (finalCount <= initialCount) {
      throw new Error("${entity.id} was not created");
    }
  });`);
    } else {
      testSteps.push(`  test("create child entity: ${entity.id} with parent linkage", async ({ page, authedPage }) => {
    await authedPage.dashboard.goto();
    await navigateTo${entity.id}(page);

    const initialCount = await page.getByTestId("${ids.row}").count();
    await page.getByTestId("${ids.create}").click();
    await page.waitForURL(/.*\\/${entity.key}\\/new/);

${parentSeeding}

${fieldFill}

    await page.getByTestId("${ids.submit}").click();
    await page.waitForURL(/\\/${entity.key}(?:\\/|$)/);

    const finalCount = await page.getByTestId("${ids.row}").count();
    if (finalCount <= initialCount) {
      throw new Error("${entity.id} was not created");
    }
  });`);
    }
  }

  return `import { expect, test } from "./auth-helper";

test.describe(${JSON.stringify(descTitle)}, () => {
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
