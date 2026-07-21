import { test, expect, describe } from "bun:test";
import {
  generateEntitySpec,
  specPath,
  generateChainSpec,
  chainSpecPath,
} from "../src/loop/boringstack/acceptance/e2e-generator";
import { planToAcceptanceSpec } from "../src/loop/acceptance/acceptance-spec";
import type {
  IEntityAcceptance,
  IAcceptanceSpec,
  IAcceptField,
} from "../src/loop/acceptance/acceptance.types";
import type { IProductPlan } from "../src/loop/planning/plan-types";

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

    // Row assertions are now scoped to the unique row, not the page
    expect(spec).toContain('row.getByTestId("company-row-name")');
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
    // Edits the row located by its unique value (identity), not by position.
    expect(spec).toContain(
      'const createdRow = page.getByTestId("company-row").filter({ hasText: unique });'
    );
    expect(spec).toContain(
      'createdRow.getByTestId("company-row-edit").click()'
    );
  });

  test("generateEntitySpec includes delete test block", () => {
    const spec = generateEntitySpec(company);

    expect(spec).toContain("delete Company: row delete, confirm, row gone");
    // Deletes the row located by its unique value (identity), not by position.
    expect(spec).toContain(
      'createdRow.getByTestId("company-row-delete").click()'
    );
    expect(spec).toContain(").toHaveCount(0, { timeout: 10000 });");
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
          name: "name",
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
      shows: ["name", "sku"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        {
          field: "name",
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

    // Verify escaped quotes in negative test title (the invalid VALUE carries the specials)
    expect(spec).toContain(
      'test("negative: Product rejects name=Invalid\\"Value`With`Specials"'
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
      // Chain spec creates entities via UI, not API seeding
      // Root entity is created without parent seeding, child selects parent from UI
      expect(chainSpec).toContain("selectOption");
      expect(chainSpec).toContain("parent0Unique");
      expect(chainSpec).not.toContain("Seed a parent Company record");
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

  test("generateChainSpec threads parent selection for child entities", () => {
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

    // Chain spec should select parent from UI, not API-seed
    expect(chainSpec).toContain("selectOption");
    expect(chainSpec).toContain("parent0Unique");
    expect(chainSpec).not.toContain("Seed a parent");
  });

  test("chainSpecPath returns correct path", () => {
    const path = chainSpecPath("/home/user/project");

    expect(path).toBe(
      "/home/user/project/apps/ui/e2e/_acceptance/chain.spec.ts"
    );
  });

  test("generateChainSpec includes serial configure to prevent concurrent test interference", () => {
    const spec: IAcceptanceSpec = {
      entities: [company],
    };

    const chainSpec = generateChainSpec(spec);

    expect(chainSpec).toContain('test.describe.configure({ mode: "serial" });');
  });

  test("recursive parent seeding: 3-level chain emits Company before Contact, Contact before Deal", () => {
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
          valid: "company-1",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    const dealEntity: IEntityAcceptance = {
      id: "Deal",
      key: "deal",
      nav: "Deals",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Test Deal",
          invalid: [],
        },
        {
          name: "contactId",
          type: "string",
          optional: false,
          valid: "contact-1",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [{ entity: "Contact", key: "contact", fkField: "contactId" }],
      negatives: [],
      acceptanceCheck: "create a deal",
    };

    const fullSpec: IAcceptanceSpec = {
      entities: [companyEntity, contactEntity, dealEntity],
    };

    // Generate spec for Deal (the deepest entity) with full spec context
    const dealSpec = generateEntitySpec(dealEntity, fullSpec);

    // Verify topological order: Company seed before Contact seed
    // (both are inside the Deal creation test, so we just verify order within the test)
    const companySeedIndex = dealSpec.indexOf("Seed parent Company");
    const contactSeedIndex = dealSpec.indexOf("Seed parent Contact");

    expect(companySeedIndex).toBeGreaterThanOrEqual(0);
    expect(contactSeedIndex).toBeGreaterThanOrEqual(0);
    expect(companySeedIndex).toBeLessThan(contactSeedIndex);

    // Verify Contact seed uses a real companyId variable, not a placeholder
    expect(dealSpec).toContain("companyId: companyId");
    // Verify it does NOT contain the placeholder string "parent-1"
    expect(dealSpec).not.toContain('companyId: "parent-1"');
  });

  test("FIX 11: generateChainSpec picks predecessor-matching FK for multi-parent child at non-zero index", () => {
    // Multi-parent child: Deal has both Contact and Company as parents
    // Chain is [Company, Contact, Deal], so Deal's predecessor is Contact (chain index 1)
    // But Deal's parents array has Company FIRST (parents[0]), Contact SECOND (parents[1])
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
          valid: "company-1",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      // Contact has Company as parent (chain predecessor at index 0)
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    // Deal child: predecessor is Contact (chain index 1)
    // But parents array has Company FIRST, Contact SECOND (opposite of chain order)
    const dealEntity: IEntityAcceptance = {
      id: "Deal",
      key: "deal",
      nav: "Deals",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Big Deal",
          invalid: [],
        },
        {
          name: "companyId",
          type: "string",
          optional: false,
          valid: "company-1",
          invalid: [],
        },
        {
          name: "contactId",
          type: "string",
          optional: false,
          valid: "contact-1",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      // Company first, Contact second (opposite of chain order)
      parents: [
        { entity: "Company", key: "company", fkField: "companyId" },
        { entity: "Contact", key: "contact", fkField: "contactId" },
      ],
      negatives: [],
      acceptanceCheck: "create a deal",
    };

    const spec: IAcceptanceSpec = {
      entities: [companyEntity, contactEntity, dealEntity],
    };

    const chainSpec = generateChainSpec(spec);

    // Should select Contact (the predecessor at chain index 1) via selectOption with label
    // Using { label: parent1Unique } syntax (the second parent in the chain, not the first in parents[])
    expect(chainSpec).toContain("selectOption({ label: parent1Unique })");
    // Should also seed+select the OTHER parent (Company) with its own variable
    expect(chainSpec).toContain("companyId");
  });

  test("FIX 11: generateChainSpec throws when non-root entity lacks parent matching predecessor", () => {
    const rootEntity: IEntityAcceptance = {
      id: "Root",
      key: "root",
      nav: "Roots",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Root",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a root",
    };

    // Child has no parent pointing to Root (the chain predecessor)
    const childEntity: IEntityAcceptance = {
      id: "Child",
      key: "child",
      nav: "Children",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Child",
          invalid: [],
        },
        {
          name: "otherId",
          type: "string",
          optional: false,
          valid: "other-1",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      // NO parent pointing to root; only has Other
      parents: [{ entity: "Other", key: "other", fkField: "otherId" }],
      negatives: [],
      acceptanceCheck: "create a child",
    };

    const spec: IAcceptanceSpec = {
      entities: [rootEntity, childEntity],
    };

    expect(() => generateChainSpec(spec)).toThrow(
      /must have a parent FK to its chain predecessor/
    );
  });
});

describe("FIX 11: planToAcceptanceSpec FK dedup", () => {
  test("a plan already declaring the FK field yields exactly one occurrence", () => {
    const planWithDeclaredFk: IProductPlan = {
      product: "CRM",
      slices: [
        {
          entity: {
            id: "Company",
            desc: "A company",
            fields: [{ name: "name", type: "string" } as const],
            relationships: [],
            rules: [],
          },
          ui: {
            screens: ["list", "form"],
            action: "add",
            shows: ["name"],
            nav: "Companies",
          },
          verification: {
            mustRemainTrue: [],
            mustNotHappen: [],
            acceptanceCheck: "create a company",
          },
        },
        {
          entity: {
            id: "Contact",
            desc: "A contact",
            fields: [
              { name: "name", type: "string" },
              // Plan ALREADY declares the companyId FK field
              { name: "companyId", type: "string" },
            ],
            relationships: ["belongsTo Company"],
            rules: [],
          },
          ui: {
            screens: ["list", "form"],
            action: "add",
            shows: ["name", "company"],
            nav: "Contacts",
          },
          verification: {
            mustRemainTrue: [],
            mustNotHappen: [],
            acceptanceCheck: "create a contact",
          },
        },
      ],
    };

    const spec = planToAcceptanceSpec(planWithDeclaredFk);
    const contact = spec.entities[1];

    if (!contact) {
      throw new Error("contact entity not found");
    }

    // Count how many fields are named companyId
    const companyIdFields = contact.fields.filter(
      (f: IAcceptField) => f.name === "companyId"
    );

    // Should be exactly one, not duplicated
    expect(companyIdFields.length).toBe(1);
  });
});
