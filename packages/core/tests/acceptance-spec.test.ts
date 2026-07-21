import { test, expect } from "bun:test";
import type { IProductPlan } from "../src/loop/planning/plan-types";
import {
  planToAcceptanceSpec,
  testIdsFor,
} from "../src/loop/acceptance/acceptance-spec";

const plan: IProductPlan = {
  product: "CRM",
  slices: [
    {
      entity: {
        id: "Company",
        desc: "c",
        fields: [
          { name: "name", type: "string" },
          { name: "website", type: "string", optional: true },
        ],
        relationships: [],
        rules: ["name is required and non-empty"],
      },
      ui: {
        screens: ["list", "form"],
        action: "add",
        shows: ["name", "website"],
        nav: "Companies",
      },
      verification: {
        mustRemainTrue: ["x"],
        mustNotHappen: ["a company can be saved without a name"],
        acceptanceCheck: "create a company",
      },
    },
    {
      entity: {
        id: "Contact",
        desc: "c",
        fields: [
          { name: "name", type: "string" },
          { name: "email", type: "string" },
        ],
        relationships: ["belongsTo Company"],
        rules: ["email must be a valid email address"],
      },
      ui: {
        screens: ["list", "form"],
        action: "add",
        shows: ["name", "email", "company"],
        nav: "Contacts",
      },
      verification: {
        mustRemainTrue: ["x"],
        mustNotHappen: ["a contact can be saved with an invalid email"],
        acceptanceCheck: "create a contact",
      },
    },
  ],
};

test("testIdsFor derives the stable contract from the entity key", () => {
  const t = testIdsFor("company");

  expect(t.list).toBe("company-list");
  expect(t.create).toBe("company-create");
  expect(t.field("name")).toBe("company-field-name");
  expect(t.rowDelete).toBe("company-row-delete");
});

test("planToAcceptanceSpec: entity key is camelCase, nav/shows/acceptanceCheck carried", () => {
  const spec = planToAcceptanceSpec(plan);
  const company = spec.entities[0];

  if (!company) {
    throw new Error("company entity not found");
  }

  expect(company.key).toBe("company");
  expect(company.nav).toBe("Companies");
  expect(company.shows).toEqual(["name", "website"]);
  expect(company.acceptanceCheck).toBe("create a company");
});

test("planToAcceptanceSpec: relationships parse to parent + fkField", () => {
  const contact = planToAcceptanceSpec(plan).entities[1];

  if (!contact) {
    throw new Error("contact entity not found");
  }

  expect(contact.parents).toEqual([
    { entity: "Company", key: "company", fkField: "companyId" },
  ]);
});

test("planToAcceptanceSpec: negatives derive missing-required + bad-email", () => {
  const spec = planToAcceptanceSpec(plan);
  const company = spec.entities[0];
  const contact = spec.entities[1];

  if (!company) {
    throw new Error("company entity not found");
  }

  if (!contact) {
    throw new Error("contact entity not found");
  }

  expect(
    company.negatives.some((n) => n.field === "name" && n.value === "")
  ).toBe(true);
  expect(
    contact.negatives.some(
      (n) => n.field === "email" && n.value.length > 0 && !n.value.includes("@")
    )
  ).toBe(true);
});

test("planToAcceptanceSpec: sample values are deterministic across calls", () => {
  expect(planToAcceptanceSpec(plan)).toEqual(planToAcceptanceSpec(plan));
});

test("planToAcceptanceSpec: rule-based negatives only for REQUIRED fields", () => {
  // Create a plan with a required field and an optional field, both with rules
  const planWithOptional: IProductPlan = {
    product: "CRM",
    slices: [
      {
        entity: {
          id: "Product",
          desc: "A product",
          fields: [
            { name: "name", type: "string", optional: false }, // required
            { name: "description", type: "string", optional: true }, // optional
          ],
          relationships: [],
          rules: [
            "name must not be empty",
            "description must not be empty when present", // rule on optional field
          ],
        },
        ui: {
          screens: ["list", "form"],
          action: "add",
          shows: ["name", "description"],
          nav: "Products",
        },
        verification: {
          mustRemainTrue: ["x"],
          mustNotHappen: [],
          acceptanceCheck: "create a product",
        },
      },
    ],
  };

  const spec = planToAcceptanceSpec(planWithOptional);
  const product = spec.entities[0];

  if (!product) {
    throw new Error("product entity not found");
  }

  // Rule-based negative should be added for required "name" field
  const nameNegatives = product.negatives.filter((n) => n.field === "name");

  expect(nameNegatives.length).toBeGreaterThan(0);
  expect(nameNegatives.some((n) => n.why.includes("must not be empty"))).toBe(
    true
  );

  // NO rule-based negative should be added for optional "description" field
  // (the rule constraint is present but doesn't apply to optional fields)
  const descNegatives = product.negatives.filter(
    (n) => n.field === "description"
  );

  expect(descNegatives.length).toBe(0);
});
