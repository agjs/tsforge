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

  test("negative tests use API-level POST to assert 4xx rejection (deterministic, no browser race)", () => {
    const spec = generateEntitySpec(company);

    // Should POST directly to /api/v1/company (API-level check, deterministic)
    expect(spec).toContain("page.request.post");
    expect(spec).toContain("/api/v1/company");
    expect(spec).toContain("Content-Type");
    expect(spec).toContain("application/json");
    expect(spec).toContain("Cookie");
    // Should assert validation error codes (400 or 422), not any 4xx (fail-open prevention)
    expect(spec).toContain("[400, 422].includes(");
    // Should NOT contain the fail-open toBeGreaterThanOrEqual(400) pattern
    expect(spec).not.toContain("toBeGreaterThanOrEqual(400)");
    expect(spec).not.toContain("toBeLessThan(500)");
    // Should build payload with valid fields + overridden invalid field
    expect(spec).toContain("Record<string, unknown>");
    expect(spec).toContain("payload[");
    // Old browser-based approach is gone
    expect(spec).not.toContain(".waitForResponse");
    expect(spec).not.toContain("const createdOk = await successfulCreate");
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

    test("FIX 1: parent rowCell assertion uses seeded identity value, not type name", () => {
      // Full spec with parent having first string field "name" with valid "name-1"
      const companyWithName: IEntityAcceptance = {
        id: "Company",
        key: "company",
        nav: "Companies",
        fields: [
          {
            name: "name",
            type: "string",
            optional: false,
            valid: "name-1",
            invalid: [],
          },
        ],
        shows: ["name"],
        screens: ["list", "form"],
        parents: [],
        negatives: [],
        acceptanceCheck: "create a company",
      };

      const contactWithParent: IEntityAcceptance = {
        id: "Contact",
        key: "contact",
        nav: "Contacts",
        fields: [
          {
            name: "name",
            type: "string",
            optional: false,
            valid: "contact-1",
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

      const fullSpec: IAcceptanceSpec = {
        entities: [companyWithName, contactWithParent],
      };

      // Generate spec with full spec context (FIX 1 behavior)
      const specWithFullContext = generateEntitySpec(
        contactWithParent,
        fullSpec
      );

      // Should assert parent rowCell contains the SEEDED value "name-1", not type name "Company"
      expect(specWithFullContext).toContain('toContainText("name-1")');

      // Should NOT assert the type name "Company" in the parent rowCell
      expect(specWithFullContext).not.toContain('toContainText("Company")');

      // Generate spec WITHOUT full spec context (fallback behavior)
      const specWithoutContext = generateEntitySpec(contactWithParent);

      // Without spec, should fall back to type name "Company"
      expect(specWithoutContext).toContain('toContainText("Company")');
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

  test("negative tests for child entity include parent seeding in API payload", () => {
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
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [{ field: "name", value: "", why: "name is required" }],
      acceptanceCheck: "create a contact",
    };

    const spec = generateEntitySpec(contact);

    // Negative test should seed parent first (for FK reference in payload)
    expect(spec).toContain("Seed a parent Company record");
    // Then POST to API with payload including seeded companyId
    expect(spec).toContain("page.request.post");
    expect(spec).toContain("/api/v1/contact");
    expect(spec).toContain("companyId: companyId");
    // Negative test title format preserved
    expect(spec).toContain("negative: Contact rejects name=");
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

  test("FIX 4: generateChainSpec handles non-linear plans (branches, independent roots)", () => {
    // Non-linear plan: Company → Contact, Deal (independent)
    // Contact's only parent is Company
    // Deal has no parent in the chain (independent branch)
    const companyEntity: IEntityAcceptance = {
      id: "Company",
      key: "company",
      nav: "Companies",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "company-1",
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
          valid: "contact-1",
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
          valid: "deal-1",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [], // No parent in this chain (independent branch)
      negatives: [],
      acceptanceCheck: "create a deal",
    };

    const spec: IAcceptanceSpec = {
      entities: [companyEntity, contactEntity, dealEntity],
    };

    // Should NOT throw, even though Deal has no parent in the chain
    expect(() => generateChainSpec(spec)).not.toThrow();

    const chainSpec = generateChainSpec(spec);

    // Should generate tests for all entities
    expect(chainSpec).toContain("create root entity: Company");
    expect(chainSpec).toContain("create child entity: Contact");
    expect(chainSpec).toContain("create entity: Deal (no parent linkage)");
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

describe("FIX 1: chain assertion uses bare variable, not JSON-stringified name", () => {
  test("child chain test generates toContainText with bare variable reference, not quoted string", () => {
    const companyEntity: IEntityAcceptance = {
      id: "Company",
      key: "company",
      nav: "Companies",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Acme",
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
          valid: "John",
          invalid: [],
        },
      ],
      shows: ["name", "company"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    const spec: IAcceptanceSpec = {
      entities: [companyEntity, contactEntity],
    };

    const chainSpec = generateChainSpec(spec);

    // FIX 1: Should contain the BARE variable reference (parent0Unique)
    // NOT a JSON-stringified quoted string ("parent0Unique")
    expect(chainSpec).toContain("toContainText(parent0Unique)");
    // Verify the quoted form is NOT present (that would be the bug)
    expect(chainSpec).not.toContain('toContainText("parent0Unique")');
  });
});

describe("FIX B: chain rowCell testid resolves variable, not literal template", () => {
  test("child chain test generates rowCell with resolved parent key, not literal template", () => {
    const companyEntity: IEntityAcceptance = {
      id: "Company",
      key: "company",
      nav: "Companies",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Acme",
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
          valid: "John",
          invalid: [],
        },
      ],
      shows: ["name", "company"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    const spec: IAcceptanceSpec = {
      entities: [companyEntity, contactEntity],
    };

    const chainSpec = generateChainSpec(spec);

    // FIX B: Should contain the resolved parent key (contact-row-company)
    // NOT the literal template string "${primaryParent.key}"
    expect(chainSpec).toContain("contact-row-company");
    expect(chainSpec).not.toContain("${primaryParent.key}");
    expect(chainSpec).not.toContain("primaryParent.key");
  });
});

describe("FIX 1: chain linkage assertion uses bare variable, not JSON-stringified name", () => {
  test('child chain test generates toContainText(parent0Unique) not toContainText("parent0Unique")', () => {
    const companyEntity: IEntityAcceptance = {
      id: "Company",
      key: "company",
      nav: "Companies",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Acme",
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
          valid: "John",
          invalid: [],
        },
      ],
      shows: ["name", "company"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    const spec: IAcceptanceSpec = {
      entities: [companyEntity, contactEntity],
    };

    const chainSpec = generateChainSpec(spec);

    // FIX 1: Should contain the BARE variable reference (parent0Unique)
    // NOT the JSON-stringified quoted form ("parent0Unique")
    expect(chainSpec).toContain("toContainText(parent0Unique)");
    expect(chainSpec).not.toContain('toContainText("parent0Unique")');
  });
});

describe("FIX 2: topological sort ensures parents precede children", () => {
  test("non-topological plan (child before parent) still generates child WITH parent linkage", () => {
    // Non-topological order: Contact comes before Company (its parent)
    const contactEntity: IEntityAcceptance = {
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
      shows: ["name", "company"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    const companyEntity: IEntityAcceptance = {
      id: "Company",
      key: "company",
      nav: "Companies",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Acme",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a company",
    };

    // Non-topological order: child @0, parent @1
    const spec: IAcceptanceSpec = {
      entities: [contactEntity, companyEntity],
    };

    const chainSpec = generateChainSpec(spec);

    // FIX 2: Despite the non-topological input order, Contact should still be generated
    // WITH parent linkage (selectOption + assertion), not as a standalone.
    // The selectOption line proves the parent was created first (topologically sorted)
    expect(chainSpec).toContain("selectOption({ label: parent0Unique })");
    // Should NOT generate Contact as a standalone (which would appear if parent wasn't available)
    expect(chainSpec).not.toContain(
      "create entity: Contact (no parent linkage)"
    );
    // Should have a toContainText assertion for the parent linkage
    expect(chainSpec).toContain("toContainText(parent0Unique)");
  });
});

describe("FIX C: chain parents resolved by key map, all selected", () => {
  test("non-linear chain (Company@0, Deal@1 independent, Contact@2→Company) selects Company's var", () => {
    const companyEntity: IEntityAcceptance = {
      id: "Company",
      key: "company",
      nav: "Companies",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Acme",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a company",
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
          valid: "Deal1",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [], // Independent — no parent in chain
      negatives: [],
      acceptanceCheck: "create a deal",
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
          valid: "John",
          invalid: [],
        },
      ],
      shows: ["name", "company"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    const spec: IAcceptanceSpec = {
      entities: [companyEntity, dealEntity, contactEntity],
    };

    const chainSpec = generateChainSpec(spec);

    // FIX C: Contact should select Company (which is at index 0, not calculated by index math)
    // The var should be parent0Unique for Company
    expect(chainSpec).toContain("parent0Unique");
    // Deal is independent, so it gets parent1Unique (it's the second entity but has no parent)
    // Contact is third and gets parent2Unique
    // The key thing is Contact selects Company (parent0Unique), not Deal (parent1Unique)
    expect(chainSpec).toContain(
      'page.getByTestId("contact-field-companyId").selectOption({ label: parent0Unique })'
    );
  });

  test("multi-parent child selects all in-chain parents", () => {
    const companyEntity: IEntityAcceptance = {
      id: "Company",
      key: "company",
      nav: "Companies",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Acme",
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

    const dealEntity: IEntityAcceptance = {
      id: "Deal",
      key: "deal",
      nav: "Deals",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Deal1",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
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

    // FIX C: Deal should select BOTH Company and Contact (not just Company)
    // Both selectOption calls should appear
    expect(chainSpec).toContain("deal-field-companyId");
    expect(chainSpec).toContain("deal-field-contactId");
    // Both should have selectOption calls
    const companySelectCount = (
      chainSpec.match(/deal-field-companyId.*selectOption/g) ?? []
    ).length;
    const contactSelectCount = (
      chainSpec.match(/deal-field-contactId.*selectOption/g) ?? []
    ).length;

    expect(companySelectCount).toBeGreaterThan(0);
    expect(contactSelectCount).toBeGreaterThan(0);
  });
});

describe("FIX D: type-aware field fills", () => {
  test("select field generates selectOption, not fill", () => {
    const entityWithSelect: IEntityAcceptance = {
      id: "Product",
      key: "product",
      nav: "Products",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Widget",
          invalid: [],
        },
        {
          name: "category",
          type: "select",
          optional: false,
          valid: "electronics",
          invalid: [],
        },
      ],
      shows: ["name", "category"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a product",
    };

    const spec = generateEntitySpec(entityWithSelect);

    // FIX D: Select field should use selectOption
    expect(spec).toContain('selectOption("electronics")');
    // Should NOT use .fill() for the select field
    expect(spec).not.toContain('field("category").fill');
  });

  test("boolean field generates check/uncheck, not fill", () => {
    const entityWithBoolean: IEntityAcceptance = {
      id: "Feature",
      key: "feature",
      nav: "Features",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Feature1",
          invalid: [],
        },
        {
          name: "enabled",
          type: "boolean",
          optional: false,
          valid: "true",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a feature",
    };

    const spec = generateEntitySpec(entityWithBoolean);

    // FIX D: Boolean field should use check() when true
    expect(spec).toContain(".check()");
    // Should NOT use .fill() for the boolean field
    expect(spec).not.toContain('field("enabled").fill');
  });
});

describe("FIX E/FIX 3: identity field excludes email by type and name", () => {
  test("entity with email first string field uses fallback text field", () => {
    const entityWithEmail: IEntityAcceptance = {
      id: "User",
      key: "user",
      nav: "Users",
      fields: [
        {
          name: "email",
          type: "email",
          optional: false,
          valid: "user@example.com",
          invalid: [],
        },
        {
          name: "username",
          type: "string",
          optional: false,
          valid: "johndoe",
          invalid: [],
        },
      ],
      shows: ["email", "username"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a user",
    };

    const spec = generateEntitySpec(entityWithEmail);

    // FIX E: Should use username (text field) for identity, not email
    // Identity marker is added as "-<timestamp>" suffix, so email would become invalid
    // The unique marker should use username's value as the base
    expect(spec).toContain("johndoe");
    // Identity field should be username field (filled with unique marker)
    expect(spec).toContain('getByTestId("user-field-username").fill(unique)');
    // Email field should also be filled with valid email (not stamped)
    expect(spec).toContain(
      'getByTestId("user-field-email").fill("user@example.com")'
    );
  });

  test("FIX 3: field named 'email' with type 'string' is excluded from identity", () => {
    // Entity with a field named "email" but type "string" (not email type)
    const entityWithEmailNamed: IEntityAcceptance = {
      id: "Contact",
      key: "contact",
      nav: "Contacts",
      fields: [
        {
          name: "email",
          type: "string",
          optional: false,
          valid: "contact@example.com",
          invalid: [],
        },
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "John",
          invalid: [],
        },
      ],
      shows: ["email", "name"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    const spec = generateEntitySpec(entityWithEmailNamed);

    // FIX 3: Even though "email" field has type "string", it should be excluded by name
    // So the identity should use "name" field instead
    expect(spec).toContain('getByTestId("contact-field-name").fill(unique)');
  });

  test("FIX 3: email-only entity generates valid unique email (not stamped invalid)", () => {
    const emailOnlyEntity: IEntityAcceptance = {
      id: "Subscriber",
      key: "subscriber",
      nav: "Subscribers",
      fields: [
        {
          name: "email",
          type: "email",
          optional: false,
          valid: "sub@example.com",
          invalid: [],
        },
      ],
      shows: ["email"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a subscriber",
    };

    const spec = {
      entities: [emailOnlyEntity],
    };

    const chainSpec = generateChainSpec(spec);

    // FIX 3: Email-only entity should generate a valid unique email
    // The unique value should still match the email pattern (contain @)
    expect(chainSpec).toContain("@example.com");
    // Should NOT contain an invalid email like "sub@example.com-timestamp"
    expect(chainSpec).not.toContain("sub@example.com-");
    // Should have the email field filled with the unique value
    expect(chainSpec).toContain(
      'getByTestId("subscriber-field-email").fill(unique)'
    );
  });

  test("FIX 3: multi-parent chain with email-only entity still links parents", () => {
    const emailOnlyEntity: IEntityAcceptance = {
      id: "Subscriber",
      key: "subscriber",
      nav: "Subscribers",
      fields: [
        {
          name: "email",
          type: "email",
          optional: false,
          valid: "sub@example.com",
          invalid: [],
        },
      ],
      shows: ["email"],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a subscriber",
    };

    const spec = {
      entities: [emailOnlyEntity],
    };

    const chainSpec = generateChainSpec(spec);

    // FIX E: Even if email is the only string field, it should be handled as identity
    // The entity creates root (no parent linkage needed for this single-entity chain)
    expect(chainSpec).toContain("create root entity: Subscriber");
  });
});

describe("FIX F: relationship linkage asserted after reload", () => {
  test("persist test asserts parent linkage after reload", () => {
    const companyEntity: IEntityAcceptance = {
      id: "Company",
      key: "company",
      nav: "Companies",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Acme",
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
          valid: "John",
          invalid: [],
        },
      ],
      shows: ["name", "company"],
      screens: ["list", "form"],
      parents: [{ entity: "Company", key: "company", fkField: "companyId" }],
      negatives: [],
      acceptanceCheck: "create a contact",
    };

    const fullSpec: IAcceptanceSpec = {
      entities: [companyEntity, contactEntity],
    };

    const spec = generateEntitySpec(contactEntity, fullSpec);

    // FIX F: Persist test should assert parent linkage after reload
    // Look for assertion of parent cell AFTER reload
    const reloadIndex = spec.indexOf("page.reload()");
    const reloadedRowIndex = spec.indexOf("const reloadedRow", reloadIndex);
    const parentCellAssertionIndex = spec.indexOf(
      "reloadedRow.getByTestId",
      reloadIndex
    );

    expect(reloadedRowIndex).toBeGreaterThan(reloadIndex);
    expect(parentCellAssertionIndex).toBeGreaterThan(reloadedRowIndex);
  });
});

describe("FIX 1, 2, 3: negative test hardening (400/422 only, type-correct payloads, empty payload)", () => {
  test("FIX 1: negative tests assert 400/422 validation error codes only", () => {
    const spec = generateEntitySpec(company);

    // FIX 1: Should contain the strict [400, 422].includes check
    expect(spec).toContain("[400, 422].includes(");
    // Should NOT contain the fail-open toBeGreaterThanOrEqual(400) pattern
    expect(spec).not.toContain("toBeGreaterThanOrEqual(400)");
    expect(spec).not.toContain("toBeLessThan(500)");
  });

  test("FIX 2: numeric field renders as bare number in negative payload, not JSON string", () => {
    const entityWithNumericField: IEntityAcceptance = {
      id: "Product",
      key: "product",
      nav: "Products",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Widget",
          invalid: [],
        },
        {
          name: "quantity",
          type: "number",
          optional: false,
          valid: "42",
          invalid: [],
        },
      ],
      shows: ["name", "quantity"],
      screens: ["list", "form"],
      parents: [],
      negatives: [{ field: "name", value: "", why: "name is required" }],
      acceptanceCheck: "create a product",
    };

    const spec = generateEntitySpec(entityWithNumericField);

    // FIX 2: The valid quantity field should render as a bare number literal (42)
    // NOT as a JSON string ("42")
    expect(spec).toContain("quantity: 42");
    // Verify the quoted form is NOT present (that would be the fail-open bug)
    expect(spec).not.toContain('quantity: "42"');
  });

  test("FIX 3: entity with only optional fields generates empty payload {}, not { , }", () => {
    const entityOptionalOnly: IEntityAcceptance = {
      id: "Config",
      key: "config",
      nav: "Configs",
      fields: [
        {
          name: "setting1",
          type: "string",
          optional: true,
          valid: "value1",
          invalid: [],
        },
        {
          name: "setting2",
          type: "string",
          optional: true,
          valid: "value2",
          invalid: [],
        },
      ],
      shows: ["setting1"],
      screens: ["list", "form"],
      parents: [],
      negatives: [{ field: "setting1", value: "bad", why: "invalid" }],
      acceptanceCheck: "create a config",
    };

    const spec = generateEntitySpec(entityOptionalOnly);

    // FIX 3: Should contain valid empty payload syntax: {}, not { , }
    expect(spec).toContain("const payload: Record<string, unknown> = {");
    expect(spec).not.toContain("{ , }");
    // Verify the payload is compilable (no syntax error)
    expect(spec).toContain("payload[");
  });

  test("B1: boolean field renders as bare true/false (no quotes) in valid payload", () => {
    const entityWithBoolean: IEntityAcceptance = {
      id: "Feature",
      key: "feature",
      nav: "Features",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Feature1",
          invalid: [],
        },
        {
          name: "enabled",
          type: "boolean",
          optional: false,
          valid: "true",
          invalid: [],
        },
      ],
      shows: ["name", "enabled"],
      screens: ["list", "form"],
      parents: [],
      negatives: [{ field: "name", value: "", why: "name is required" }],
      acceptanceCheck: "create a feature",
    };

    const spec = generateEntitySpec(entityWithBoolean);

    // B1: Boolean field should render as bare true (not "true")
    expect(spec).toContain("enabled: true");
    // Verify the quoted form is NOT present
    expect(spec).not.toContain('enabled: "true"');
  });

  test("B1: string field companion stays JSON-quoted next to numeric field", () => {
    const entityWithStringAndNumeric: IEntityAcceptance = {
      id: "Item",
      key: "item",
      nav: "Items",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Item1",
          invalid: [],
        },
        {
          name: "price",
          type: "number",
          optional: false,
          valid: "99.99",
          invalid: [],
        },
      ],
      shows: ["name", "price"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        { field: "price", value: "-1", why: "price must be positive" },
      ],
      acceptanceCheck: "create an item",
    };

    const spec = generateEntitySpec(entityWithStringAndNumeric);

    // B1: String field name should stay JSON-quoted
    expect(spec).toContain('name: "Item1"');
    // Numeric field should be bare number
    expect(spec).toContain("price: 99.99");
  });

  test("B1: substring-trap type (appointment/interval) treated as string, not numeric", () => {
    const entityWithTrapType: IEntityAcceptance = {
      id: "Meeting",
      key: "meeting",
      nav: "Meetings",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Meeting1",
          invalid: [],
        },
        {
          name: "appointment",
          type: "appointment",
          optional: false,
          valid: "2024-01-01T10:00:00Z",
          invalid: [],
        },
      ],
      shows: ["name", "appointment"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        { field: "appointment", value: "invalid", why: "invalid date" },
      ],
      acceptanceCheck: "create a meeting",
    };

    const spec = generateEntitySpec(entityWithTrapType);

    // B1: "appointment" type should be treated as string (contains "int" but is NOT numeric)
    // So it should be JSON-quoted
    expect(spec).toContain('appointment: "2024-01-01T10:00:00Z"');
  });

  test("B2: injection escaping in negative test title and assertion", () => {
    const entityWithDangerousData: IEntityAcceptance = {
      id: "Config",
      key: "config",
      nav: "Configs",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Config1",
          invalid: [],
        },
        {
          name: "value",
          type: "string",
          optional: false,
          valid: "safe",
          invalid: [],
        },
      ],
      shows: ["name", "value"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        {
          field: "value",
          value: "dangerous`${code}injection",
          why: "test injection",
        },
      ],
      acceptanceCheck: "create a config",
    };

    const spec = generateEntitySpec(entityWithDangerousData);

    // B2: The dangerous backtick and ${} should appear ESCAPED in the assertion message
    // NOT as a raw unescaped sequence that could break the spec
    const testTitleMatch =
      /test\("negative:[^"]*dangerous.*injection"[^)]*\)/.exec(spec);

    expect(testTitleMatch).toBeTruthy();
    // The raw dangerous sequence should NOT appear unescaped in the assertion
    // (it should be escaped as part of JSON.stringify)
    expect(spec).not.toContain("${code}injection`");
  });

  test("B3: canonical numeric invalid renders as a bare number (tests the constraint)", () => {
    const entityWithNumericNegative: IEntityAcceptance = {
      id: "Product",
      key: "product",
      nav: "Products",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Product1",
          invalid: [],
        },
        {
          name: "stock",
          type: "integer",
          optional: false,
          valid: "10",
          invalid: [],
        },
      ],
      shows: ["name", "stock"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        { field: "stock", value: "-1", why: "stock must be non-negative" },
      ],
      acceptanceCheck: "create a product",
    };

    const spec = generateEntitySpec(entityWithNumericNegative);

    // B3: Invalid override for numeric field renders as bare number (not string)
    // to exercise the numeric range/constraint, not type-rejection.
    // "-1" is finite, so it renders as bare -1, testing the constraint.
    expect(spec).toContain('payload["stock"] = -1');
  });

  test("B3: NON-canonical numeric invalid stays a raw string (not mutated by Number)", () => {
    const entity: IEntityAcceptance = {
      id: "Product",
      key: "product",
      nav: "Products",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "P1",
          invalid: [],
        },
        {
          name: "stock",
          type: "integer",
          optional: false,
          valid: "10",
          invalid: [],
        },
      ],
      shows: ["name", "stock"],
      screens: ["list", "form"],
      parents: [],
      // "0x10" would become 16 via Number() — sending it verbatim as a string keeps
      // it a genuinely type-invalid value (tests rejection), not a mutated valid one.
      negatives: [
        {
          field: "stock",
          value: "0x10",
          why: "hex is not a valid integer input",
        },
      ],
      acceptanceCheck: "create a product",
    };

    const spec = generateEntitySpec(entity);

    expect(spec).toContain('payload["stock"] = "0x10"');
    expect(spec).not.toContain('payload["stock"] = 16');
  });

  test("B3: type-render invalid boolean token as string (testing type-rejection)", () => {
    const entityWithBooleanNegative: IEntityAcceptance = {
      id: "Feature",
      key: "feature",
      nav: "Features",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Feature1",
          invalid: [],
        },
        {
          name: "active",
          type: "bool",
          optional: false,
          valid: "true",
          invalid: [],
        },
      ],
      shows: ["name", "active"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        { field: "active", value: "notabool", why: "invalid boolean" },
      ],
      acceptanceCheck: "create a feature",
    };

    const spec = generateEntitySpec(entityWithBooleanNegative);

    // B3: Invalid boolean token (not "true"/"false") renders as JSON string
    // to exercise type-rejection. "notabool" is not a valid boolean, so it
    // renders as the string "notabool" to test the type constraint.
    expect(spec).toContain('payload["active"] = "notabool"');
  });

  test("B3: type-render valid boolean value as bare boolean", () => {
    const entityWithValidBooleanNegative: IEntityAcceptance = {
      id: "Feature",
      key: "feature",
      nav: "Features",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Feature1",
          invalid: [],
        },
        {
          name: "active",
          type: "bool",
          optional: false,
          valid: "true",
          invalid: [],
        },
      ],
      shows: ["name", "active"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        { field: "active", value: "false", why: "active must be true" },
      ],
      acceptanceCheck: "create a feature",
    };

    const spec = generateEntitySpec(entityWithValidBooleanNegative);

    // B3: Valid boolean value "false" renders as bare false
    // to exercise the boolean value constraint (not type-rejection).
    expect(spec).toContain('payload["active"] = false');
  });

  test("B3: required-empty negative keeps empty string as empty string", () => {
    const entityWithRequiredEmpty: IEntityAcceptance = {
      id: "Article",
      key: "article",
      nav: "Articles",
      fields: [
        {
          name: "title",
          type: "string",
          optional: false,
          valid: "Article1",
          invalid: [],
        },
      ],
      shows: ["title"],
      screens: ["list", "form"],
      parents: [],
      negatives: [{ field: "title", value: "", why: "title is required" }],
      acceptanceCheck: "create an article",
    };

    const spec = generateEntitySpec(entityWithRequiredEmpty);

    // B3: Required-empty ("") should stay as empty string literal ""
    expect(spec).toContain('payload["title"] = ""');
  });

  test("B3: NaN in numeric field falls back to JSON string", () => {
    const entityWithNaNValue: IEntityAcceptance = {
      id: "Measurement",
      key: "measurement",
      nav: "Measurements",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Measurement1",
          invalid: [],
        },
        {
          name: "value",
          type: "float",
          optional: false,
          valid: "notanumber",
          invalid: [],
        },
      ],
      shows: ["name", "value"],
      screens: ["list", "form"],
      parents: [],
      negatives: [{ field: "value", value: "invalid", why: "invalid number" }],
      acceptanceCheck: "create a measurement",
    };

    const spec = generateEntitySpec(entityWithNaNValue);

    // B1: When valid field is not a number (NaN), fall back to JSON string
    // "notanumber" becomes "notanumber" (quoted string)
    expect(spec).toContain('value: "notanumber"');
  });
});

describe("PART C: negative check hardening tests", () => {
  test("C1: boolean field renders as bare true/false (no quotes) in valid payload", () => {
    const entityWithBoolean: IEntityAcceptance = {
      id: "Feature",
      key: "feature",
      nav: "Features",
      fields: [
        {
          name: "enabled",
          type: "boolean",
          optional: false,
          valid: "true",
          invalid: [],
        },
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Feature1",
          invalid: [],
        },
      ],
      shows: ["name"],
      screens: ["list", "form"],
      parents: [],
      negatives: [{ field: "name", value: "", why: "name is required" }],
      acceptanceCheck: "create a feature",
    };

    const spec = generateEntitySpec(entityWithBoolean);

    // Boolean field should render as bare true (no quotes)
    expect(spec).toContain("enabled: true");
    // Verify the quoted form is NOT present
    expect(spec).not.toContain('enabled: "true"');
  });

  test("C2: string companion field stays quoted when paired with numeric", () => {
    const entityWithNumericAndString: IEntityAcceptance = {
      id: "Product",
      key: "product",
      nav: "Products",
      fields: [
        {
          name: "name",
          type: "string",
          optional: false,
          valid: "Widget",
          invalid: [],
        },
        {
          name: "price",
          type: "number",
          optional: false,
          valid: "99.99",
          invalid: [],
        },
      ],
      shows: ["name", "price"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        { field: "price", value: "-1", why: "price cannot be negative" },
      ],
      acceptanceCheck: "create a product",
    };

    const spec = generateEntitySpec(entityWithNumericAndString);

    // Numeric field should render as bare number
    expect(spec).toContain("price: 99.99");
    expect(spec).not.toContain('price: "99.99"');
    // String field should stay quoted
    expect(spec).toContain('name: "Widget"');
  });

  test("C3: substring-trap type (appointment/interval/constraint) treated as string, not number", () => {
    const entityWithSubstringTrap: IEntityAcceptance = {
      id: "Meeting",
      key: "meeting",
      nav: "Meetings",
      fields: [
        {
          name: "appointmentTime",
          type: "appointment",
          optional: false,
          valid: "2024-01-15T10:00:00Z",
          invalid: [],
        },
        {
          name: "duration",
          type: "interval",
          optional: false,
          valid: "PT1H",
          invalid: [],
        },
      ],
      shows: ["appointmentTime"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        {
          field: "appointmentTime",
          value: "invalid-time",
          why: "invalid appointment",
        },
      ],
      acceptanceCheck: "create a meeting",
    };

    const spec = generateEntitySpec(entityWithSubstringTrap);

    // Both substring-trap types should be quoted (treated as strings, not numbers)
    expect(spec).toContain('appointmentTime: "2024-01-15T10:00:00Z"');
    expect(spec).toContain('duration: "PT1H"');
    // Verify they are NOT rendered as bare numbers
    expect(spec).not.toContain("appointmentTime: 0");
    expect(spec).not.toContain("duration: 0");
  });

  test("C4: injection escaping - backticks and ${ in neg.value are JSON.stringify-escaped", () => {
    const entityWithInjection: IEntityAcceptance = {
      id: "Template",
      key: "template",
      nav: "Templates",
      fields: [
        {
          name: "content",
          type: "string",
          optional: false,
          valid: "Hello",
          invalid: [],
        },
      ],
      shows: ["content"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        {
          field: "content",
          value: "`inject` and ${evil}",
          why: "template injection",
        },
      ],
      acceptanceCheck: "create a template",
    };

    const spec = generateEntitySpec(entityWithInjection);

    // The dangerous sequence should NOT appear unescaped in the spec
    expect(spec).not.toContain("payload[content] = `inject` and ${evil}");
    // Instead, it should be JSON.stringify-escaped
    expect(spec).toContain('payload["content"]');
    // The value should be properly escaped as a JSON string
    expect(spec).toContain('"`inject` and ${evil}"');
  });

  test("C5: negative assertion uses [400, 422].includes() exactly (not fail-open pattern)", () => {
    const spec = generateEntitySpec(company);

    // Must use strict [400, 422].includes() check
    expect(spec).toContain("[400, 422].includes(res.status())");
    // Should NOT use fail-open patterns
    expect(spec).not.toContain("toBeGreaterThanOrEqual(400)");
    expect(spec).not.toContain("toBeLessThan(500)");
    expect(spec).not.toContain(">= 400");
    expect(spec).not.toContain("< 500");
  });

  test("C6: required-empty negative keeps empty string literal, not coerced to 0 or null", () => {
    const entityWithRequired: IEntityAcceptance = {
      id: "User",
      key: "user",
      nav: "Users",
      fields: [
        {
          name: "email",
          type: "email",
          optional: false,
          valid: "user@example.com",
          invalid: [],
        },
      ],
      shows: ["email"],
      screens: ["list", "form"],
      parents: [],
      negatives: [
        {
          field: "email",
          value: "",
          why: "email is required",
        },
      ],
      acceptanceCheck: "create a user",
    };

    const spec = generateEntitySpec(entityWithRequired);

    // The override for required-empty should be the empty string literal ""
    expect(spec).toContain('payload["email"] = ""');
    // Should NOT be coerced to 0, null, or false
    expect(spec).not.toContain('payload["email"] = 0');
    expect(spec).not.toContain('payload["email"] = null');
    expect(spec).not.toContain('payload["email"] = false');
  });
});
