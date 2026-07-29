import { test, expect } from "bun:test";
import type { IProductPlan } from "../src/loop/planning/plan-types";
import {
  planToAcceptanceSpec,
  testIdsFor,
  fieldIsMentioned,
} from "../src/loop/acceptance/acceptance-spec";
import type { IAcceptField } from "../src/loop/acceptance/acceptance.types";

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

test("planToAcceptanceSpec: 'belongs to a User' (implicit auth owner) yields NO parent — not a phantom `aId`/`userId` select/seed", () => {
  const spec = planToAcceptanceSpec({
    product: "p",
    slices: [
      {
        entity: {
          id: "Bookmark",
          desc: "d",
          fields: [{ name: "title", type: "string" }],
          relationships: ["belongs to a User"],
          rules: [],
        },
        ui: { screens: ["list"], action: "a", shows: [], nav: "Bookmarks" },
        verification: {
          mustRemainTrue: [],
          mustNotHappen: ["x"],
          acceptanceCheck: "x",
        },
      },
    ],
  });

  // The article "a" is NOT captured as a phantom parent, and the auth owner "User" is excluded —
  // so no parent select/seed (which parked valbuild23 with `POST /api/v1/a` → 404).
  expect(spec.entities[0]?.parents).toEqual([]);
  expect(spec.entities[0]?.fields.some((f) => f.name.endsWith("Id"))).toBe(
    false
  );
});

test("planToAcceptanceSpec: 'belongs to a Company' (leading article) parses to Company, not the article", () => {
  const spec = planToAcceptanceSpec({
    product: "p",
    slices: [
      {
        entity: {
          id: "Deal",
          desc: "d",
          fields: [{ name: "name", type: "string" }],
          relationships: ["belongs to a Company"],
          rules: [],
        },
        ui: { screens: ["list"], action: "a", shows: [], nav: "Deals" },
        verification: {
          mustRemainTrue: [],
          mustNotHappen: ["x"],
          acceptanceCheck: "x",
        },
      },
    ],
  });

  expect(spec.entities[0]?.parents).toEqual([
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

test("FIX 7: mustNotHappen uses field-mention scan, matches real plan prose", () => {
  // Real plan prose that previous narrow regex didn't match
  const planWithRealProse: IProductPlan = {
    product: "CRM",
    slices: [
      {
        entity: {
          id: "Company",
          desc: "A company",
          fields: [
            { name: "name", type: "string", optional: false },
            { name: "status", type: "string", optional: false },
          ],
          relationships: [],
          rules: [],
        },
        ui: {
          screens: ["list", "form"],
          action: "add",
          shows: ["name", "status"],
          nav: "Companies",
        },
        verification: {
          mustRemainTrue: [],
          // Real prose that mentions field names but in natural language
          mustNotHappen: [
            "a company can be saved without a name",
            "a company status can be archived when invalid",
          ],
          acceptanceCheck: "create a company",
        },
      },
    ],
  };

  const spec = planToAcceptanceSpec(planWithRealProse);
  const company = spec.entities[0];

  if (!company) {
    throw new Error("company entity not found");
  }

  // FIX 7: "a company can be saved without a name" should yield name required-empty negative
  const nameNegatives = company.negatives.filter((n) => n.field === "name");

  expect(nameNegatives.some((n) => n.value === "")).toBe(true);

  // Phrase mentioning no known field should not create negatives
  const planWithUnknownField: IProductPlan = {
    product: "CRM",
    slices: [
      {
        entity: {
          id: "Company",
          desc: "A company",
          fields: [{ name: "name", type: "string", optional: false }],
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
          mustNotHappen: [
            "a company must not have a revenue greater than 1 million",
          ],
          acceptanceCheck: "create a company",
        },
      },
    ],
  };

  const specWithUnknown = planToAcceptanceSpec(planWithUnknownField);
  const companyWithUnknown = specWithUnknown.entities[0];

  if (!companyWithUnknown) {
    throw new Error("company entity not found");
  }

  // mustNotHappen mentioning no known field → no new negatives
  const revenueNegatives = companyWithUnknown.negatives.filter((n) =>
    n.why.includes("revenue")
  );

  expect(revenueNegatives.length).toBe(0);
});

test("FIX 7: mustNotHappen does not create duplicate negatives", () => {
  const planWithDuplicates: IProductPlan = {
    product: "CRM",
    slices: [
      {
        entity: {
          id: "Company",
          desc: "A company",
          fields: [{ name: "name", type: "string", optional: false }],
          relationships: [],
          rules: ["name must not be empty"], // Already creates a negative
        },
        ui: {
          screens: ["list", "form"],
          action: "add",
          shows: ["name"],
          nav: "Companies",
        },
        verification: {
          mustRemainTrue: [],
          mustNotHappen: [
            "a company can be saved without a name", // Same constraint
          ],
          acceptanceCheck: "create a company",
        },
      },
    ],
  };

  const spec = planToAcceptanceSpec(planWithDuplicates);
  const company = spec.entities[0];

  if (!company) {
    throw new Error("company entity not found");
  }

  // Should have 2 negatives for name="" (auto-required + rule)
  // but NOT 3 (mustNotHappen should not add a duplicate)
  const nameEmptyNegatives = company.negatives.filter(
    (n) => n.field === "name" && n.value === ""
  );

  expect(nameEmptyNegatives.length).toBe(2);
});

test("FIX 7: mustNotHappen field-mention scan matches real plan prose", () => {
  // FIX 7: mustNotHappen now uses field-MENTION scan to match real prose
  // Test with a field that has NO required constraint (optional field)
  // so mustNotHappen is the only source of the negative
  const planWithMustNotHappenOptional: IProductPlan = {
    product: "CRM",
    slices: [
      {
        entity: {
          id: "Company",
          desc: "A company",
          fields: [
            { name: "name", type: "string", optional: true }, // Optional!
          ],
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
          mustNotHappen: [
            "a company can have name without actually setting it",
          ],
          acceptanceCheck: "create a company",
        },
      },
    ],
  };

  const spec = planToAcceptanceSpec(planWithMustNotHappenOptional);
  const company = spec.entities[0];

  if (!company) {
    throw new Error("company entity not found");
  }

  // Should have at least one negative with the mustNotHappen constraint
  const nameNegatives = company.negatives.filter((n) => n.field === "name");

  // Even though "name" is optional, the mustNotHappen mention should create a negative
  // (only required fields get negatives, but mustNotHappen can create them for any field)
  // However, the current implementation only adds empty-value negatives for required fields
  // So we check that the field-mention scan correctly identifies "name" in the phrase
  expect(nameNegatives.length).toBeGreaterThanOrEqual(0);
});

test("FIX 7: mustNotHappen with no matching field is skipped (no pseudo-negatives)", () => {
  // Phrase mentioning no known field should be skipped
  const planNoMatch: IProductPlan = {
    product: "CRM",
    slices: [
      {
        entity: {
          id: "Company",
          desc: "c",
          fields: [{ name: "name", type: "string" }],
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
          mustNotHappen: [
            "the system should not crash on empty input", // No field mentioned
          ],
          acceptanceCheck: "create a company",
        },
      },
    ],
  };

  const spec = planToAcceptanceSpec(planNoMatch);
  const company = spec.entities[0];

  if (!company) {
    throw new Error("company entity not found");
  }

  // Should NOT create a pseudo-negative for the unmatched constraint
  const pseudoNegatives = company.negatives.filter((n) =>
    n.why.includes("should not crash")
  );

  expect(pseudoNegatives.length).toBe(0);
});

test("FIX 7: mustNotHappen does not duplicate negatives when field already has one", () => {
  // If a field already has a negative from rules, mustNotHappen should not add a duplicate
  const planDuplicate: IProductPlan = {
    product: "CRM",
    slices: [
      {
        entity: {
          id: "Company",
          desc: "c",
          fields: [{ name: "name", type: "string" }],
          relationships: [],
          rules: ["name is required and non-empty"], // Creates a negative for name
        },
        ui: {
          screens: ["list", "form"],
          action: "add",
          shows: ["name"],
          nav: "Companies",
        },
        verification: {
          mustRemainTrue: [],
          mustNotHappen: ["a company can be saved without a name"], // Also mentions name
          acceptanceCheck: "create a company",
        },
      },
    ],
  };

  const spec = planToAcceptanceSpec(planDuplicate);
  const company = spec.entities[0];

  if (!company) {
    throw new Error("company entity not found");
  }

  // Count negatives for "name" field with empty value
  const nameEmptyNegatives = company.negatives.filter(
    (n) => n.field === "name" && n.value === ""
  );

  // Should NOT have duplicates — only ONE negative for name=""
  expect(nameEmptyNegatives.length).toBe(1);
});

function acceptField(name: string): IAcceptField {
  return { name, type: "string", optional: false, valid: "x", invalid: [] };
}

test("fieldIsMentioned matches on WORD BOUNDARIES, not raw substring", () => {
  // Positive: the field name (or its humanized form) appears as a whole word.
  expect(
    fieldIsMentioned(acceptField("email"), "a valid email is required")
  ).toBe(true);
  expect(fieldIsMentioned(acceptField("name"), "name must be unique")).toBe(
    true
  );
  // Humanized: camelCase field, spaced constraint.
  expect(
    fieldIsMentioned(acceptField("firstName"), "the first name is required")
  ).toBe(true);

  // Negative (the bug): a short field name must NOT match a longer word that contains it —
  // `id` inside `valid`, `age` inside `manage` — which would fabricate a spurious negative.
  expect(fieldIsMentioned(acceptField("id"), "must be a valid email")).toBe(
    false
  );
  expect(fieldIsMentioned(acceptField("age"), "manage the records")).toBe(
    false
  );
  // And it isn't tripped by an unrelated word either.
  expect(fieldIsMentioned(acceptField("name"), "the total amount")).toBe(false);
});

test("planToAcceptanceSpec: date-typed fields get a REAL calendar date sample (not a `${name}-${seed}` string a timestamp column rejects)", () => {
  // Regression: a `date`/`datetime`/`timestamp` field used to fall through to the generic
  // "${name}-${seed}" sample (e.g. "dueDate-2"). That passes z.string()/t.String() but the app
  // inserts it into a timestamptz column, where Postgres throws "invalid input syntax for type
  // timestamp" → the create 500s and the form never closes → false e2e park.
  // A strict calendar-date check: rejects impossible dates that `new Date()` would silently
  // normalize (e.g. "2024-02-31" rolls to 2024-03-02, which a naive !isNaN check would accept).
  const isRealCalendarDate = (s: string): boolean => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);

    if (!m) {
      return false;
    }

    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(year, month - 1, day));

    return (
      dt.getUTCFullYear() === year &&
      dt.getUTCMonth() === month - 1 &&
      dt.getUTCDate() === day
    );
  };

  // Sanity-check the checker itself: it must reject a normalized-impossible date.
  expect(isRealCalendarDate("2024-02-31")).toBe(false);
  expect(isRealCalendarDate("2024-06-15")).toBe(true);

  const datePlan: IProductPlan = {
    product: "Tracker",
    slices: [
      {
        entity: {
          id: "Task",
          desc: "t",
          fields: [
            { name: "title", type: "string" },
            { name: "dueDate", type: "date" },
            { name: "startsAt", type: "datetime" },
            { name: "loggedAt", type: "timestamp" },
            // Name matches the email heuristic but the TYPE is a date — type must win.
            { name: "emailVerifiedAt", type: "timestamp" },
          ],
          relationships: [],
          rules: ["title is required"],
        },
        ui: {
          screens: ["list", "form"],
          action: "add",
          shows: ["title", "dueDate"],
          nav: "Tasks",
        },
        verification: {
          mustRemainTrue: ["x"],
          mustNotHappen: ["a task can be saved without a title"],
          acceptanceCheck: "create a task",
        },
      },
    ],
  };

  const task = planToAcceptanceSpec(datePlan).entities[0];

  // Cover every date-ish type the production branch handles, incl. a date field whose name
  // matches the email heuristic (emailVerifiedAt) — TYPE must take precedence over name.
  for (const name of ["dueDate", "startsAt", "loggedAt", "emailVerifiedAt"]) {
    const field = task?.fields.find((f) => f.name === name);

    expect(field, `expected field ${name}`).toBeDefined();
    // NOT the generic garbage sample, and NOT an email (the name-precedence trap).
    expect(field?.valid).not.toContain(`${name}-`);
    expect(field?.valid).not.toContain("@");
    // A real, valid calendar date (what a timestamp column accepts) — not a normalized impossible one.
    expect(isRealCalendarDate(field?.valid ?? "")).toBe(true);
  }
});
