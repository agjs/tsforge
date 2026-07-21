import { test, expect, describe } from "bun:test";
import {
  generateEntitySpec,
  specPath,
} from "../src/loop/boringstack/acceptance/e2e-generator";
import type { IEntityAcceptance } from "../src/loop/acceptance/acceptance.types";

const company: IEntityAcceptance = {
  id: "Company",
  key: "company",
  nav: "Companies",
  fields: [
    {
      name: "name",
      type: "string",
      optional: false,
      valid: "Acme Corp",
      invalid: [],
    },
    {
      name: "website",
      type: "string",
      optional: true,
      valid: "https://example.com",
      invalid: [],
    },
  ],
  shows: ["name", "website"],
  screens: ["list", "form"],
  parents: [],
  negatives: [
    { field: "name", value: "", why: "name is required" },
    {
      field: "website",
      value: "not-a-url",
      why: "invalid website format",
    },
  ],
  acceptanceCheck: "create a company",
};

describe("E2E spec generator", () => {
  test("generateEntitySpec includes Playwright @playwright/test import", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain('import { expect, test } from "../fixtures/auth"');
  });

  test("generateEntitySpec includes fixture usage (authedPage)", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain("authedPage.dashboard.goto()");
  });

  test("generateEntitySpec uses getByTestId selector", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain('page.getByTestId("company-create")');
  });

  test("generateEntitySpec fills form fields with valid values", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain(
      'page.getByTestId("company-field-name").fill("Acme Corp")'
    );
    expect(spec).toContain(
      'page.getByTestId("company-field-website").fill("https://example.com")'
    );
  });

  test("generateEntitySpec clicks submit button", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain('page.getByTestId("company-submit").click()');
  });

  test("generateEntitySpec asserts row appears with created values", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain('page.getByTestId("company-row-name")');
    expect(spec).toContain("toContainText");
  });

  test("generateEntitySpec includes reload/persist assertion", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain("page.reload()");
    expect(spec).toContain("persists after page reload");
  });

  test("generateEntitySpec includes navigation test", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain("navigate to company list via sidebar");
    expect(spec).toContain('page.getByTestId("nav-company").click()');
  });

  test("generateEntitySpec includes create test block", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain("create Company: form fill, submit, row appears");
  });

  test("generateEntitySpec includes update test block", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain("update Company: edit form, change field, save");
    expect(spec).toContain(
      'page.getByTestId("company-row-edit").first().click()'
    );
  });

  test("generateEntitySpec includes delete test block", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain("delete Company: row delete, confirm, row gone");
    expect(spec).toContain(
      'page.getByTestId("company-row-delete").last().click()'
    );
  });

  test("generateEntitySpec includes negative tests for required and formatted fields", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain("negative: Company rejects name=");
    expect(spec).toContain("negative: Company rejects website=not-a-url");
  });

  test("generateEntitySpec includes empty state check", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain('page.getByTestId("company-empty")');
    expect(spec).toContain("company list is present or empty state shown");
  });

  test("specPath returns correct path", () => {
    const path = specPath("/home/user/project", "company");

    expect(path).toBe(
      "/home/user/project/apps/ui/e2e/_acceptance/company.spec.ts"
    );
  });

  test("specPath uses the key provided", () => {
    const path = specPath("/tmp", "contact");

    expect(path).toContain("contact.spec.ts");
    expect(path).toContain("_acceptance");
  });

  test("generateEntitySpec escapes quotes and backticks in field values", () => {
    const entityWithSpecialChars: IEntityAcceptance = {
      id: "Product",
      key: "product",
      nav: "Products",
      fields: [
        {
          name: 'name"with"quotes',
          type: "string",
          optional: false,
          valid: 'Value with "double quotes" and `backticks`',
          invalid: [],
        },
        {
          name: "sku",
          type: "string",
          optional: false,
          valid: "SKU-123",
          invalid: [],
        },
      ],
      shows: ['name"with"quotes', "sku"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        {
          field: 'name"with"quotes',
          value: 'Invalid"Value`With`Specials',
          why: "invalid format",
        },
      ],
      acceptanceCheck: "create a product",
    };

    const spec = generateEntitySpec(entityWithSpecialChars);

    // Verify escaped double quotes appear in field fill steps
    expect(spec).toContain(
      '.fill("Value with \\"double quotes\\" and `backticks`")'
    );

    // Verify escaped quotes in negative test title
    expect(spec).toContain(
      'test("negative: Product rejects name\\"with\\"quotes=Invalid\\"Value`With`Specials"'
    );

    // Verify escaped quotes in error messages
    expect(spec).toContain(
      'throw new Error("Product with invalid name\\"with\\"quotes should not have been created")'
    );

    // Verify that the raw unescaped version does NOT appear (which would break the spec)
    const rawBad = '.fill("Value with "double quotes"';

    expect(spec).not.toContain(rawBad);
  });
});
