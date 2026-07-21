import type { ITestIds } from "../../acceptance/acceptance.types";

/**
 * Build a human-readable guide teaching the model which data-testid attributes
 * are required for a feature's UI to be testable end-to-end.
 */
export function buildTestIdGuide(key: string, ids: ITestIds): string {
  return `## Test IDs for "${key}" — Required Test Hooks

Every UI element that end-to-end tests will interact with MUST have a \`data-testid\` attribute with its corresponding test ID. These IDs are stable identifiers that allow automated tests to find and interact with your UI.

**Required test IDs for the "${key}" feature:**

- **Navigation link**: \`data-testid="${ids.nav}"\` — the link to navigate to this feature
- **List container**: \`data-testid="${ids.list}"\` — the main list/table element showing all records
- **Empty state**: \`data-testid="${ids.empty}"\` — shown when no records exist
- **Create button**: \`data-testid="${ids.create}"\` — the button to open the create form
- **Form container**: \`data-testid="${ids.form}"\` — the form element for create/edit
- **Submit button**: \`data-testid="${ids.submit}"\` — the submit button inside the form
- **Form fields**: \`data-testid="${ids.field("fieldName")}"\` — each input field (e.g. \`${ids.field("name")}\`, \`${ids.field("email")}\`)
- **Table row**: \`data-testid="${ids.row}"\` — each row in the list (use this as a prefix, e.g. in a \`data-testid\` attribute on the row container)
- **Row cells**: \`data-testid="${ids.rowCell("fieldName")}"\` — data cells within rows (e.g. \`${ids.rowCell("name")}\`)
- **Row edit button**: \`data-testid="${ids.rowEdit}"\` — the edit action on each row
- **Row delete button**: \`data-testid="${ids.rowDelete}"\` — the delete action on each row
- **Delete confirmation dialog**: \`data-testid="${ids.confirmDelete}"\` — the confirmation prompt when deleting a record

**Pattern example** (for a field named "title" in a "task" feature):
- In the create/edit form: \`<input data-testid="task-field-title" />\`
- In the table row: \`<td data-testid="task-row-title">{record.title}</td>\`

**Where to add them:**
- List page component: add \`data-testid="${ids.list}"\` to the list/table container, \`data-testid="${ids.empty}"\` to the empty state
- Create button: add \`data-testid="${ids.create}"\` to the button that opens the form
- Form component: add \`data-testid="${ids.form}"\` to the \`<form>\`, \`data-testid="${ids.submit}"\` to the submit button, and \`data-testid="${ids.field("...")}\` to each input
- Table rows: add \`data-testid="${ids.row}"\` to each row container, \`data-testid="${ids.rowCell("...")}\` to data cells, \`data-testid="${ids.rowEdit}"\` and \`data-testid="${ids.rowDelete}"\` to action buttons
- Delete confirmation: add \`data-testid="${ids.confirmDelete}"\` to the confirmation dialog

Without these test IDs, the feature cannot be validated end-to-end and will not be accepted.`;
}

/**
 * Check that a set of UI source files contain the required test ID markers.
 * Returns a list of missing-testid error messages (empty array = all present, pass).
 * @param sources - Map of {filePath → source code}
 * @param ids - The ITestIds contract for this feature
 */
export function checkTestIds(
  sources: Map<string, string>,
  ids: ITestIds
): string[] {
  const errors: string[] = [];
  const source = Array.from(sources.values()).join("\n");

  // Check all critical IDs are present in the source code
  const requiredIds = [
    ids.list,
    ids.empty,
    ids.create,
    ids.form,
    ids.submit,
    ids.row,
    ids.rowEdit,
    ids.rowDelete,
    ids.confirmDelete,
  ];

  for (const id of requiredIds) {
    if (!source.includes(`data-testid="${id}"`)) {
      errors.push(id);
    }
  }

  return errors;
}
