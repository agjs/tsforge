import { test, expect, describe } from "bun:test";
import {
  buildTestIdGuide,
  checkTestIds,
} from "../src/loop/boringstack/acceptance/testid-contract";
import { testIdsFor } from "../src/loop/acceptance/acceptance-spec";

describe("buildTestIdGuide", () => {
  test("generates guide text that mentions each required testid", () => {
    const ids = testIdsFor("company");
    const guide = buildTestIdGuide("company", ids);

    // Check that the guide mentions the key ID names
    expect(guide).toContain(ids.list);
    expect(guide).toContain(ids.empty);
    expect(guide).toContain(ids.create);
    expect(guide).toContain(ids.form);
    expect(guide).toContain(ids.submit);
    expect(guide).toContain(ids.row);
    expect(guide).toContain(ids.rowEdit);
    expect(guide).toContain(ids.rowDelete);
    expect(guide).toContain(ids.confirmDelete);
    expect(guide).toContain(ids.field("name"));
    expect(guide).toContain(ids.rowCell("name"));

    // Check that it includes guidance about where to add them
    expect(guide).toContain("data-testid");
    expect(guide).toContain("Where to add them");
  });

  test("guide includes feature-specific references", () => {
    const ids = testIdsFor("contact");
    const guide = buildTestIdGuide("contact", ids);

    expect(guide).toContain("contact");
    expect(guide).toContain(ids.field("email"));
  });
});

describe("checkTestIds", () => {
  test("returns empty array when all required testids are present", () => {
    const ids = testIdsFor("company");
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

    const result = checkTestIds(new Map([["test.tsx", source]]), ids);

    expect(result).toEqual([]);
  });

  test("reports missing create button testid", () => {
    const ids = testIdsFor("company");
    const source = `
      <div data-testid="${ids.list}">
        <div data-testid="${ids.empty}">No records</div>
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

    const result = checkTestIds(new Map([["test.tsx", source]]), ids);

    expect(result).toContain(ids.create);
  });

  test("reports all missing testids in one call", () => {
    const ids = testIdsFor("company");
    const source = "<div>no testids here</div>";

    const result = checkTestIds(new Map([["test.tsx", source]]), ids);

    // Should report all missing IDs
    expect(result.length).toBeGreaterThan(5);
    expect(result).toContain(ids.list);
    expect(result).toContain(ids.create);
    expect(result).toContain(ids.submit);
  });

  test("checks across multiple source files", () => {
    const ids = testIdsFor("company");
    const listComponent = `<div data-testid="${ids.list}"></div>`;
    const formComponent = `
      <form data-testid="${ids.form}">
        <input data-testid="${ids.field("name")}" />
        <button data-testid="${ids.submit}">Submit</button>
      </form>
    `;
    const rowComponent = `
      <div data-testid="${ids.row}">
        <button data-testid="${ids.rowDelete}">Delete</button>
      </div>
    `;

    const sources = new Map([
      ["List.tsx", listComponent],
      ["Form.tsx", formComponent],
      ["Row.tsx", rowComponent],
      [
        "CreateButton.tsx",
        `<button data-testid="${ids.create}">Create</button>`,
      ],
      [
        "DeleteConfirm.tsx",
        `<div data-testid="${ids.confirmDelete}">Confirm</div>`,
      ],
      ["EmptyState.tsx", `<div data-testid="${ids.empty}">Empty</div>`],
      ["RowEdit.tsx", `<button data-testid="${ids.rowEdit}">Edit</button>`],
      ["RowCell.tsx", `<td data-testid="${ids.rowCell("name")}">Name</td>`],
    ]);

    const result = checkTestIds(sources, ids);

    expect(result).toEqual([]);
  });

  test("is case-sensitive for testid attribute", () => {
    const ids = testIdsFor("company");
    // Using wrong case for data-testid (dataTestId instead of data-testid)
    const source = `<div dataTestId="${ids.list}">Content</div>`;

    const result = checkTestIds(new Map([["test.tsx", source]]), ids);

    // Should fail because we specifically look for data-testid= (not dataTestId)
    expect(result).toContain(ids.list);
  });
});
