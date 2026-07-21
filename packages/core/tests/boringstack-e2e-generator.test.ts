import { test, expect, describe } from "bun:test";
import {
  generateEntitySpec,
  specPath,
  generateChainSpec,
  chainSpecPath,
} from "../src/loop/boringstack/acceptance/e2e-generator";
import type {
  IEntityAcceptance,
  IAcceptanceSpec,
} from "../src/loop/acceptance/acceptance.types";

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
  test("generateEntitySpec includes auth helper import", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain('import { expect, test } from "./auth-helper"');
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
    expect(spec).toContain("navigateToCompany(page)");
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

  describe("Relationship-aware spec generation", () => {
    const companyEntity: IEntityAcceptance = {
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
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a company",
    };

    const contactEntity: IEntityAcceptance = {
      id: "Contact",
      key: "contact",
      nav: "Contacts",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "John Doe",
          invalid: [],
        },
        {
          name: "companyId",
          type: "string",
          optional: false,
          valid: "comp-123",
          invalid: [],
        },
      ],
      shows: ["name", "company"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    test("generateEntitySpec for child entity includes parent seeding code", () => {
      const spec = generateEntitySpec(contactEntity);

      expect(spec).toContain("Seed a parent Company record");
      expect(spec).toContain("/api/v1/company");
    });

    test("generateEntitySpec for child entity uses selectOption for FK field", () => {
      const spec = generateEntitySpec(contactEntity);

      expect(spec).toContain("selectOption(companyId)");
    });

    test("generateChainSpec generates multi-entity spec with dependency order", () => {
      const spec = {
        entities: [companyEntity, contactEntity],
      };

      const chainSpec = generateChainSpec(spec);

      expect(chainSpec).toContain("Full Relational Chain: Company → Contact");
      expect(chainSpec).toContain("create root entity: Company");
      expect(chainSpec).toContain(
        "create child entity: Contact with parent linkage"
      );
      expect(chainSpec).toContain("Seed a parent Company record");
    });

    test("generateChainSpec for single entity still creates valid spec", () => {
      const spec = {
        entities: [companyEntity],
      };

      const chainSpec = generateChainSpec(spec);

      expect(chainSpec).toContain("Full Relational Chain: Company");
      expect(chainSpec).toContain("create root entity: Company");
      expect(chainSpec).not.toContain("create child entity");
    });
  });
});

describe("E2E spec generator - Relationships", () => {
  test("generateEntitySpec with parent relationship seeds parent via API", () => {
    const contact: IEntityAcceptance = {
      id: "Contact",
      key: "contact",
      nav: "Contacts",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "John Doe",
          invalid: [],
        },
        {
          name: "email",
          type: "string",
          optional: false,
          valid: "john@example.com",
          invalid: [],
        },
      ],
      shows: ["name", "email"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [{ field: "name", value: "", why: "name is required" }],
      acceptanceCheck: "create a contact",
    };

    const spec = generateEntitySpec(contact);

    // Should seed parent Company via API
    expect(spec).toContain("Seed a parent Company record");
    expect(spec).toContain("/api/v1/company");
    expect(spec).toContain("Company-for-Contact");
  });

  test("generateEntitySpec with parent relationship selects parent in form", () => {
    const contact: IEntityAcceptance = {
      id: "Contact",
      key: "contact",
      nav: "Contacts",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "John Doe",
          invalid: [],
        },
        {
          name: "companyId",
          type: "string",
          optional: false,
          valid: "comp-1",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    const spec = generateEntitySpec(contact);

    // Should use selectOption for FK field instead of fill
    expect(spec).toContain("selectOption(companyId)");
    expect(spec).not.toContain(
      'page.getByTestId("contact-field-companyId").fill'
    );
  });

  test("generateChainSpec creates test for each entity in dependency order", () => {
    const spec: IAcceptanceSpec = {
      entities: [
        company,
        {
          ...company,
          id: "Contact",
          key: "contact",
          nav: "Contacts",
          parents: [
            { entity: "Company", key: "company", fkField: "companyId" },
          ],
        },
      ],
    };

    const chainSpec = generateChainSpec(spec);

    // Should have both entities
    expect(chainSpec).toContain("Company → Contact");
    expect(chainSpec).toContain("create root entity: Company");
    expect(chainSpec).toContain("create child entity: Contact");
  });

  test("generateChainSpec includes parent seeding for child entities", () => {
    const contact: IEntityAcceptance = {
      id: "Contact",
      key: "contact",
      nav: "Contacts",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "John",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    const spec: IAcceptanceSpec = {
      entities: [company, contact],
    };

    const chainSpec = generateChainSpec(spec);

    expect(chainSpec).toContain("Seed a parent");
  });

  test("chainSpecPath returns correct path", () => {
    const path = chainSpecPath("/home/user/project");

    expect(path).toBe(
      "/home/user/project/apps/ui/e2e/_acceptance/chain.spec.ts"
    );
  });
});
