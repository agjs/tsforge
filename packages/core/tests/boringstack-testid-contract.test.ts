import { test, expect, describe } from "bun:test";
import type { IProductPlan } from "../src/loop/planning/plan-types";
import {
  buildTestIdGuide,
  checkTestIds,
  checkWiring,
  requiredTestIds,
} from "../src/loop/boringstack/acceptance/testid-contract";
import {
  planToAcceptanceSpec,
  testIdsFor,
} from "../src/loop/acceptance/acceptance-spec";
import type { IEntityAcceptance } from "../src/loop/acceptance/acceptance.types";

/** Build a minimal entity where the FIRST field is a parent FK (the distinguishing case the
 *  Contact fixture can't exercise — its first field "name" is already non-FK). */
const fkFirstEntity: IEntityAcceptance = {
  id: "Membership",
  key: "membership",
  nav: "Memberships",
  fields: [
    {
      name: "userId",
      type: "string",
      optional: false,
      valid: "u1",
      invalid: [],
    },
    {
      name: "role",
      type: "string",
      optional: false,
      valid: "admin",
      invalid: [],
    },
  ],
  shows: ["role"],
  screens: ["list", "form"],
  parents: [{ entity: "User", key: "user", fkField: "userId" }],
  negatives: [],
  acceptanceCheck: "create a membership",
};

/** An entity whose ONLY field is a parent FK — the all-FK edge (join/link entity). */
const allFkEntity: IEntityAcceptance = {
  id: "Link",
  key: "link",
  nav: "Links",
  fields: [
    {
      name: "userId",
      type: "string",
      optional: false,
      valid: "u1",
      invalid: [],
    },
  ],
  shows: [],
  screens: ["list", "form"],
  parents: [{ entity: "User", key: "user", fkField: "userId" }],
  negatives: [],
  acceptanceCheck: "create a link",
};

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
    const ids = testIdsFor(contact.key);

    expect(guide).toContain("are NOT plain inputs");
    // The non-FK fields ARE still listed as plain inputs.
    expect(guide).toContain('for the "name" field');
    expect(guide).toContain('for the "email" field');
    // CRITICAL (regression the park was caused by): companyId must NOT appear as a plain-input
    // form-field bullet. The plain-field bullets read `data-testid="…" for the "<field>" field`;
    // assert that exact phrasing is absent for companyId (it lives in the <select> section instead).
    expect(guide).not.toContain(
      `\`data-testid="${ids.field("companyId")}"\` for the "companyId" field`
    );
  });

  test("Pattern example names a NON-FK field even when the FIRST field IS a parent FK", () => {
    // Distinguishing case the Contact fixture can't exercise (its fields[0]="name" is already non-FK).
    // Here fields[0]="userId" IS the FK, so a regression to entity.fields[0] would show the FK as an
    // <input> — contradicting the <select> mandate. The example must pick "role" (the non-FK field).
    const guide = buildTestIdGuide(fkFirstEntity);
    const ids = testIdsFor(fkFirstEntity.key);

    expect(guide).toContain(`<input data-testid="${ids.field("role")}" />`);
    // The FK is NEVER shown as an <input> in the example.
    expect(guide).not.toContain(`<input data-testid="${ids.field("userId")}"`);
  });

  test("all-FK entity: Pattern example shows a <select>, NEVER an <input> of the FK", () => {
    // Edge: an entity whose only field is a parent FK must not fall back to rendering it as an <input>.
    const guide = buildTestIdGuide(allFkEntity);
    const ids = testIdsFor(allFkEntity.key);

    expect(guide).toContain(`<select data-testid="${ids.field("userId")}">`);
    expect(guide).not.toContain(`<input data-testid="${ids.field("userId")}"`);
    // shows=[] → NO row-cell example (rowCell testids exist only for shows; never invent one).
    expect(guide).not.toContain("In the table row:");
    expect(guide).not.toContain(ids.rowCell("userId"));
  });

  test("empty-fields entity: invents NO field name and emits NO row-cell example", () => {
    // Edge (round-3 finding): with fields=[] and shows=[], the guide must not invent "name" nor
    // reference record.name / a rowCell testid that isn't in the contract.
    const emptyEntity: IEntityAcceptance = {
      id: "Blank",
      key: "blank",
      nav: "Blanks",
      fields: [],
      shows: [],
      screens: ["list", "form"],
      parents: [],
      negatives: [],
      acceptanceCheck: "create a blank",
    };
    const guide = buildTestIdGuide(emptyEntity);

    expect(guide).not.toContain("In the table row:");
    expect(guide).not.toContain("record.name");
    // Falls to the generic form-field note (no invented field, no <select>/<input> of a fake field).
    expect(guide).toContain("give each form field a `data-testid`");
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

describe("checkWiring — reject a hollow shell (build49 false-green)", () => {
  const contactEntity: IEntityAcceptance = {
    id: "Contact",
    key: "contact",
    nav: "Contacts",
    fields: [
      {
        name: "name",
        type: "string",
        optional: false,
        valid: "A",
        invalid: [],
      },
    ],
    shows: ["name"],
    screens: ["list", "form"],
    parents: [],
    negatives: [],
    acceptanceCheck: "create a contact",
  };

  // The exact build49 shape: hooks DEFINED in their own file + referenced ONLY by
  // their test, never wired into the page. Must flag all four as dead.
  test("flags a hollow feature whose CRUD hooks are defined but never wired", () => {
    const files = new Map<string, string>([
      ["Contact.queries.ts", "export function useContact() { return []; }"],
      [
        "Contact.mutations.ts",
        "export function useCreateContact() {} export function useUpdateContact() {} export function useDeleteContact() {}",
      ],
      ["Contact.queries.test.tsx", "useContact();"],
      [
        "Contact.mutations.test.tsx",
        "useCreateContact(); useUpdateContact(); useDeleteContact();",
      ],
      [
        "components/ContactPage/ContactPage.tsx",
        "export const ContactPage = () => (<main data-testid='contact-list'><tr data-testid='contact-row'><td>-</td></tr></main>);",
      ],
    ]);

    const dead = checkWiring(files, contactEntity);

    expect(dead).toContain("useContact");
    expect(dead).toContain("useCreateContact");
    expect(dead).toContain("useUpdateContact");
    expect(dead).toContain("useDeleteContact");
  });

  test("passes when hooks are wired DIRECTLY in the page component", () => {
    const files = new Map<string, string>([
      ["Contact.queries.ts", "export function useContact() { return []; }"],
      [
        "Contact.mutations.ts",
        "export function useCreateContact() {} export function useUpdateContact() {} export function useDeleteContact() {}",
      ],
      [
        "components/ContactPage/ContactPage.tsx",
        `import { useContact } from "../../Contact.queries";
         import { useCreateContact, useUpdateContact, useDeleteContact } from "../../Contact.mutations";
         export const ContactPage = () => {
           const rows = useContact();
           const create = useCreateContact(); const update = useUpdateContact(); const del = useDeleteContact();
           return <div>{rows.map((r) => r.name)}</div>;
         };`,
      ],
    ]);

    expect(checkWiring(files, contactEntity)).toEqual([]);
  });

  test("passes when hooks are wired via the view hook (.hooks.ts), the scaffold idiom", () => {
    const files = new Map<string, string>([
      ["Contact.queries.ts", "export function useContact() { return []; }"],
      [
        "Contact.mutations.ts",
        "export function useCreateContact() {} export function useUpdateContact() {} export function useDeleteContact() {}",
      ],
      [
        "components/ContactPage/ContactPage.hooks.ts",
        `import { useContact } from "../../Contact.queries";
         import { useCreateContact, useUpdateContact, useDeleteContact } from "../../Contact.mutations";
         export function useContactPage() {
           const rows = useContact();
           return { rows, onSubmit: useCreateContact(), onEdit: useUpdateContact(), onDelete: useDeleteContact() };
         }`,
      ],
      [
        "components/ContactPage/ContactPage.tsx",
        "export const ContactPage = () => { const view = useContactPage(); return <div />; };",
      ],
    ]);

    expect(checkWiring(files, contactEntity)).toEqual([]);
  });

  test("word-boundary: useContact is not satisfied by useContactPage alone", () => {
    const files = new Map<string, string>([
      ["Contact.queries.ts", "export function useContact() { return []; }"],
      [
        "components/ContactPage/ContactPage.tsx",
        "export const ContactPage = () => { useContactPage(); return <div/>; };",
      ],
    ]);

    // useContact appears only in its definition file (useContactPage does NOT count) → dead.
    expect(checkWiring(files, contactEntity)).toContain("useContact");
  });
});

describe("checkWiring — the bypasses must NOT pass (a mention is not a call)", () => {
  const ce: IEntityAcceptance = {
    id: "Contact",
    key: "contact",
    nav: "Contacts",
    fields: [
      {
        name: "name",
        type: "string",
        optional: false,
        valid: "A",
        invalid: [],
      },
    ],
    shows: ["name"],
    screens: ["list", "form"],
    parents: [],
    negatives: [],
    acceptanceCheck: "create a contact",
  };
  const defs: [string, string][] = [
    ["Contact.queries.ts", "export function useContact() { return []; }"],
    [
      "Contact.mutations.ts",
      "export function useCreateContact() {} export function useUpdateContact() {} export function useDeleteContact() {}",
    ],
  ];

  test("IMPORT-only (hooks imported but never invoked) is still HOLLOW", () => {
    const files = new Map<string, string>([
      ...defs,
      [
        "components/ContactPage/ContactPage.tsx",
        `import { useContact } from "../../Contact.queries";
         import { useCreateContact, useUpdateContact, useDeleteContact } from "../../Contact.mutations";
         export const ContactPage = () => <main data-testid='contact-list'>-</main>;`,
      ],
    ]);
    // Names appear in a 2nd file, but with NO call paren → must all be flagged dead.
    const dead = checkWiring(files, ce);
    expect(dead).toContain("useContact");
    expect(dead).toContain("useCreateContact");
    expect(dead).toContain("useUpdateContact");
    expect(dead).toContain("useDeleteContact");
  });

  test("RE-EXPORT barrel (export { useX }) is not wiring", () => {
    const files = new Map<string, string>([
      ...defs,
      [
        "index.ts",
        `export { useContact } from "./Contact.queries";
         export { useCreateContact, useUpdateContact, useDeleteContact } from "./Contact.mutations";`,
      ],
    ]);
    expect(checkWiring(files, ce).sort()).toEqual(
      [
        "useContact",
        "useCreateContact",
        "useDeleteContact",
        "useUpdateContact",
      ].sort()
    );
  });

  test("a comment / type mention that names the hook is not wiring", () => {
    const files = new Map<string, string>([
      ...defs,
      [
        "components/ContactPage/ContactPage.tsx",
        `// TODO: wire useCreateContact here later
         type X = typeof useUpdateContact;
         export const ContactPage = () => { const rows = useContact(); const d = useDeleteContact(); return <div>{rows.map(String)}</div>; };`,
      ],
    ]);
    // useContact + useDeleteContact are CALLED → ok; useCreateContact (comment) + useUpdateContact
    // (type ref) are only mentioned → dead.
    const dead = checkWiring(files, ce);
    expect(dead).toContain("useCreateContact");
    expect(dead).toContain("useUpdateContact");
    expect(dead).not.toContain("useContact");
    expect(dead).not.toContain("useDeleteContact");
  });
});
