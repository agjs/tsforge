import { test, expect, describe } from "bun:test";
import type { IProductPlan } from "../src/loop/planning/plan-types";
import {
  buildTestIdGuide,
  checkTestIds,
  requiredTestIds,
} from "../src/loop/boringstack/acceptance/testid-contract";
import {
  planToAcceptanceSpec,
  testIdsFor,
} from "../src/loop/acceptance/acceptance-spec";

// Create a test entity with fields, shows, and a parent relationship
const testPlan: IProductPlan = {
  product: "Test",
  slices: [
    {
      entity: {
        id: "Contact",
        desc: "A contact",
        fields: [
          { name: "name", type: "string" },
          { name: "email", type: "string" },
        ],
        relationships: ["belongsTo Company"],
        rules: [],
      },
      ui: {
        screens: ["list", "form"],
        action: "add",
        shows: ["name", "email"],
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

const spec = planToAcceptanceSpec(testPlan);
const contact = spec.entities[0];

if (!contact) {
  throw new Error("contact entity not found in test setup");
}

describe("requiredTestIds", () => {
  test("includes static testids", () => {
    const required = requiredTestIds(contact);
    const ids = testIdsFor(contact.key);

    expect(required).toContain(ids.nav);
    expect(required).toContain(ids.list);
    expect(required).toContain(ids.empty);
    expect(required).toContain(ids.create);
    expect(required).toContain(ids.form);
    expect(required).toContain(ids.submit);
    expect(required).toContain(ids.row);
    expect(required).toContain(ids.rowEdit);
    expect(required).toContain(ids.rowDelete);
    expect(required).toContain(ids.confirmDelete);
  });

  test("includes field testids for each entity field", () => {
    const required = requiredTestIds(contact);
    const ids = testIdsFor(contact.key);

    expect(required).toContain(ids.field("name"));
    expect(required).toContain(ids.field("email"));
  });

  test("includes field testids for parent foreign keys", () => {
    const required = requiredTestIds(contact);
    const ids = testIdsFor(contact.key);

    // Contact has a parent Company with fkField: companyId
    expect(required).toContain(ids.field("companyId"));
  });

  test("includes rowCell testids for each show", () => {
    const required = requiredTestIds(contact);
    const ids = testIdsFor(contact.key);

    expect(required).toContain(ids.rowCell("name"));
    expect(required).toContain(ids.rowCell("email"));
  });
});

describe("buildTestIdGuide", () => {
  test("generates guide text that mentions each required testid", () => {
    const guide = buildTestIdGuide(contact);

    const required = requiredTestIds(contact);

    for (const id of required) {
      expect(guide).toContain(id);
    }

    // Check that it includes guidance about where to add them
    expect(guide).toContain("data-testid");
    expect(guide).toContain("Where to add them");
  });

  test("directs the confirm-delete testid to the CONFIRM BUTTON, not the dialog wrapper", () => {
    const guide = buildTestIdGuide(contact);
    const ids = testIdsFor(contact.key);

    // The E2E delete step CLICKS confirm-delete to confirm. If the model puts it on the dialog
    // overlay/wrapper <div> (the natural reading of "confirmation dialog"), the click hits the
    // backdrop, the delete mutation never fires, the row stays, and delete acceptance fails every
    // time. The guide must say BUTTON.
    expect(guide).toContain(ids.confirmDelete);
    expect(guide.toUpperCase()).toContain("CONFIRM BUTTON");
    expect(guide).toContain("NOT the dialog");
  });

  test("directs the nav testid to the shared sidebar (reachability)", () => {
    const guide = buildTestIdGuide(contact);
    const ids = testIdsFor(contact.key);

    // The nav hook lives OUTSIDE the feature dir; the guide must tell the
    // model to wire it into the sidebar, or features are built unreachable.
    expect(guide).toContain(ids.nav);
    expect(guide).toContain("AppSidebar");
  });

  test("guide includes all entity fields as required inputs", () => {
    const guide = buildTestIdGuide(contact);

    for (const field of contact.fields) {
      expect(guide).toContain(field.name);
    }
  });

  test("guide includes all shows as required row cells", () => {
    const guide = buildTestIdGuide(contact);

    for (const show of contact.shows) {
      expect(guide).toContain(show);
    }
  });

  test("guide includes parent relationship selectors", () => {
    const guide = buildTestIdGuide(contact);

    for (const parent of contact.parents) {
      expect(guide).toContain(parent.key);
      expect(guide).toContain(parent.fkField);
    }
  });

  test("directs a parent FK field to a native <select> (Playwright selectOption), NOT an <input>", () => {
    // build35 Contact parked: the model built companyId as an <input>, but acceptance uses Playwright
    // selectOption which only works on a native <select>. The guide must mandate a <select>.
    const guide = buildTestIdGuide(contact);
    const ids = testIdsFor(contact.key);

    expect(guide).toContain("native `<select>`");
    expect(guide).toContain("selectOption");
    // The FK field's testid appears attached to a <select>, not a plain input.
    expect(guide).toContain(`<select data-testid="${ids.field("companyId")}">`);
  });

  test("does NOT list a parent FK field among the plain <input> form fields", () => {
    // The FK field must not be double-listed as a plain input (which is what led the model to build
    // an <input>). It's flagged as NOT a plain input and deferred to the relationship selectors.
    const guide = buildTestIdGuide(contact);

    expect(guide).toContain("are NOT plain inputs");
    // The non-FK fields ARE still listed as plain inputs.
    expect(guide).toContain('for the "name" field');
    expect(guide).toContain('for the "email" field');
  });

  test("guide agreement: contains exactly the required testids", () => {
    const guide = buildTestIdGuide(contact);
    const required = requiredTestIds(contact);

    // Every required ID must appear in the guide
    for (const id of required) {
      expect(guide).toContain(id);
    }

    // The guide should mention the complete contract
    expect(guide).toContain("Complete contract");
    expect(guide).toContain(`${required.length} required`);
  });
});

describe("checkTestIds", () => {
  test("agreement: enforces exactly the required testids", () => {
    // Build a source with ALL required testids
    const required = requiredTestIds(contact);
    const source = required.map((id) => `data-testid="${id}"`).join(" ");

    const result = checkTestIds(new Map([["test.tsx", source]]), contact);

    expect(result).toEqual([]);
  });

  test("accepts SINGLE-quoted testids (prettier/eslint emit data-testid='x')", () => {
    // Regression: the generated JSX is single-quoted, but the gate previously
    // matched only double quotes and reported every present testid as missing,
    // parking every feature. A single-quoted source with ALL testids must pass.
    const required = requiredTestIds(contact);
    const source = required.map((id) => `data-testid='${id}'`).join(" ");

    const result = checkTestIds(new Map([["test.tsx", source]]), contact);

    expect(result).toEqual([]);
  });

  test("still detects a genuinely missing testid in single-quoted source", () => {
    const ids = testIdsFor(contact.key);
    const required = requiredTestIds(contact);
    // single-quoted source missing only the "name" field testid
    const source = required
      .filter((id) => id !== ids.field("name"))
      .map((id) => `data-testid='${id}'`)
      .join(" ");

    const result = checkTestIds(new Map([["test.tsx", source]]), contact);

    expect(result).toContain(ids.field("name"));
  });

  test("does NOT require nav testid in feature dir (nav lives in shared sidebar)", () => {
    const ids = testIdsFor(contact.key);
    const required = requiredTestIds(contact);

    // Build source with all IDs EXCEPT nav
    const otherIds = required.filter((id) => !id.includes("nav"));
    const source = otherIds.map((id) => `data-testid="${id}"`).join(" ");

    const result = checkTestIds(new Map([["test.tsx", source]]), contact);

    // nav should NOT be reported as missing (it's not checked in feature dir)
    expect(result).not.toContain(ids.nav);
  });

  test("detects missing field testid for entity fields", () => {
    const ids = testIdsFor(contact.key);
    const required = requiredTestIds(contact);

    // Build source missing the "name" field testid
    const otherIds = required.filter((id) => id !== ids.field("name"));
    const source = otherIds.map((id) => `data-testid="${id}"`).join(" ");

    const result = checkTestIds(new Map([["test.tsx", source]]), contact);

    expect(result).toContain(ids.field("name"));
  });

  test("detects missing field testid for parent foreign key", () => {
    const ids = testIdsFor(contact.key);
    const required = requiredTestIds(contact);

    // Build source missing the "companyId" field testid (parent FK)
    const otherIds = required.filter((id) => id !== ids.field("companyId"));
    const source = otherIds.map((id) => `data-testid="${id}"`).join(" ");

    const result = checkTestIds(new Map([["test.tsx", source]]), contact);

    expect(result).toContain(ids.field("companyId"));
  });

  test("detects missing rowCell testid for shows", () => {
    const ids = testIdsFor(contact.key);
    const required = requiredTestIds(contact);

    // Build source missing the "email" row cell testid
    const otherIds = required.filter((id) => id !== ids.rowCell("email"));
    const source = otherIds.map((id) => `data-testid="${id}"`).join(" ");

    const result = checkTestIds(new Map([["test.tsx", source]]), contact);

    expect(result).toContain(ids.rowCell("email"));
  });

  test("does NOT report nav testid as missing (nav is in shared sidebar)", () => {
    const ids = testIdsFor(contact.key);
    const source = `
      <div data-testid="${ids.list}">
        <div data-testid="${ids.empty}">No records</div>
        <button data-testid="${ids.create}">Create</button>
        <form data-testid="${ids.form}">
          <input data-testid="${ids.field("name")}" />
          <button data-testid="${ids.submit}">Submit</button>
        </form>
        <div data-testid="${ids.row}">
          <span data-testid="${ids.rowCell("name")}">Test</span>
          <button data-testid="${ids.rowEdit}">Edit</button>
          <button data-testid="${ids.rowDelete}">Delete</button>
        </div>
        <div data-testid="${ids.confirmDelete}">Confirm?</div>
      </div>
    `;

    const result = checkTestIds(new Map([["test.tsx", source]]), contact);

    // nav is not checked in feature dir (it's in the shared sidebar)
    expect(result).not.toContain(ids.nav);
  });

  test("returns empty array when all required testids are present", () => {
    const ids = testIdsFor(contact.key);
    const source = `
      <div data-testid="${ids.nav}">
        <div data-testid="${ids.list}">
          <div data-testid="${ids.empty}">No records</div>
          <button data-testid="${ids.create}">Create</button>
          <form data-testid="${ids.form}">
            <input data-testid="${ids.field("name")}" />
            <input data-testid="${ids.field("email")}" />
            <select data-testid="${ids.field("companyId")}"></select>
            <button data-testid="${ids.submit}">Submit</button>
          </form>
          <div data-testid="${ids.row}">
            <span data-testid="${ids.rowCell("name")}">Test</span>
            <span data-testid="${ids.rowCell("email")}">email</span>
            <button data-testid="${ids.rowEdit}">Edit</button>
            <button data-testid="${ids.rowDelete}">Delete</button>
          </div>
          <div data-testid="${ids.confirmDelete}">Confirm?</div>
        </div>
      </div>
    `;

    const result = checkTestIds(new Map([["test.tsx", source]]), contact);

    expect(result).toEqual([]);
  });

  test("checks across multiple source files", () => {
    const ids = testIdsFor(contact.key);
    const sources = new Map([
      ["Nav.tsx", `<a data-testid="${ids.nav}">Contacts</a>`],
      ["List.tsx", `<div data-testid="${ids.list}"></div>`],
      ["Empty.tsx", `<div data-testid="${ids.empty}">No records</div>`],
      ["Create.tsx", `<button data-testid="${ids.create}">Create</button>`],
      [
        "Form.tsx",
        `
        <form data-testid="${ids.form}">
          <input data-testid="${ids.field("name")}" />
          <input data-testid="${ids.field("email")}" />
          <select data-testid="${ids.field("companyId")}"></select>
          <button data-testid="${ids.submit}">Submit</button>
        </form>
      `,
      ],
      [
        "Row.tsx",
        `
        <div data-testid="${ids.row}">
          <span data-testid="${ids.rowCell("name")}">Name</span>
          <span data-testid="${ids.rowCell("email")}">Email</span>
          <button data-testid="${ids.rowEdit}">Edit</button>
          <button data-testid="${ids.rowDelete}">Delete</button>
        </div>
      `,
      ],
      ["Confirm.tsx", `<div data-testid="${ids.confirmDelete}">Confirm</div>`],
    ]);

    const result = checkTestIds(sources, contact);

    expect(result).toEqual([]);
  });

  test("is case-sensitive for testid attribute", () => {
    const ids = testIdsFor(contact.key);
    // Using wrong case for data-testid (dataTestId instead of data-testid)
    const source = `<div dataTestId="${ids.list}">Content</div>`;

    const result = checkTestIds(new Map([["test.tsx", source]]), contact);

    // Should fail because we specifically look for data-testid= (not dataTestId)
    expect(result).toContain(ids.list);
  });
});
