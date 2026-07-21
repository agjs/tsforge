import {
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
    const url = `${uiBase}:${uiPort}/dashboard`;
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
    const url = `${uiBase}:${uiPort}/login`;
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
        email: `e2e-${String(workerInfo.workerIndex)}-${randomUUID()}@e2e.test`,
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
          `Failed to register e2e test user (HTTP ${String(registerRes.status())}): ${body}`
        );
      }

      // Force-verify the user (test endpoint)
      const verifyRes = await ctx.post("/api/v1/auth/__test/force-verify", {
        data: { email: user.email },
      });

      if (!verifyRes.ok()) {
        const body = await verifyRes.text();
        throw new Error(
          `Failed to force-verify e2e test user (HTTP ${String(verifyRes.status())}): ${body}`
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
    await page.waitForURL(/\/dashboard/);
    await use({ login, dashboard });
  },
});

export { expect };
