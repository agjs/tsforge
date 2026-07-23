import type { IEntityAcceptance } from "../../acceptance/acceptance.types";
import { testIdsFor } from "../../acceptance/acceptance-spec";

/**
 * Compute the COMPLETE set of required testids for an entity.
 * This is the single source of truth: the guide teaches these,
 * the gate enforces these, and the E2E runner targets these.
 *
 * Returns:
 * - Static IDs: nav, list, empty, create, form, submit, row, rowEdit, rowDelete, confirmDelete
 * - field(name) for each field in entity.fields
 * - field(fkField) for each parent in entity.parents (relationship selects)
 * - rowCell(name) for each name in entity.shows
 */
export function requiredTestIds(entity: IEntityAcceptance): string[] {
  const ids = testIdsFor(entity.key);
  const required: string[] = [
    ids.nav,
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

  // Track which field testids we've added to avoid duplicates
  const addedFieldTestIds = new Set<string>();

  for (const field of entity.fields) {
    const fieldTestId = ids.field(field.name);

    if (!addedFieldTestIds.has(fieldTestId)) {
      required.push(fieldTestId);
      addedFieldTestIds.add(fieldTestId);
    }
  }

  // Parent FK fields are already in entity.fields (injected during spec generation),
  // so this deduplication is implicit. But for clarity, we verify we don't double-add.
  for (const parent of entity.parents) {
    const fieldTestId = ids.field(parent.fkField);

    if (!addedFieldTestIds.has(fieldTestId)) {
      required.push(fieldTestId);
      addedFieldTestIds.add(fieldTestId);
    }
  }

  for (const show of entity.shows) {
    required.push(ids.rowCell(show));
  }

  return required;
}

/**
 * Build a human-readable guide teaching the model which data-testid attributes
 * are required for a feature's UI to be testable end-to-end.
 */
export function buildTestIdGuide(entity: IEntityAcceptance): string {
  const ids = testIdsFor(entity.key);
  const required = requiredTestIds(entity);
  // The <input> Pattern example must use a NON-relationship field — a parent FK renders as a
  // <select> (see Relationship selectors), so it must NEVER show an FK as an <input>. When the
  // entity has no plain field (all fields are FKs), show the <select> form instead of an <input>.
  const plainFieldName = entity.fields.find(
    (f) => !entity.parents.some((p) => p.fkField === f.name)
  )?.name;
  const firstParentFk = entity.parents[0]?.fkField;
  // Row-cell example ONLY when a real `shows` column exists — rowCell testids are generated for
  // entity.shows only, so never invent a field name or reference a non-contract testid here.
  const firstShow = entity.shows[0];
  const rowExampleLine =
    firstShow === undefined
      ? ""
      : `\n- In the table row: \`<td data-testid="${ids.rowCell(firstShow)}">{record.${firstShow}}</td>\``;
  const formExample =
    plainFieldName !== undefined
      ? `**Pattern example** (for a NON-relationship field named "${plainFieldName}" in a "${entity.key}" feature):
- In the create/edit form: \`<input data-testid="${ids.field(plainFieldName)}" />\` (a parent FK field is a \`<select>\` instead — see Relationship selectors)`
      : firstParentFk !== undefined
        ? `**Pattern example** (every field of "${entity.key}" is a parent foreign key — render each as a native \`<select>\`, NEVER an \`<input>\`):
- In the create/edit form: \`<select data-testid="${ids.field(firstParentFk)}"> … </select>\``
        : `**Pattern example**: give each form field a \`data-testid\` on its \`<input>\` control.`;
  const patternExample = `${formExample}${rowExampleLine}`;

  return `## Test IDs for "${entity.key}" — Required Test Hooks

Every UI element that end-to-end tests will interact with MUST have a \`data-testid\` attribute with its corresponding test ID. These IDs are stable identifiers that allow automated tests to find and interact with your UI.

**Required test IDs for the "${entity.key}" feature:**

- **Navigation link**: \`data-testid="${ids.nav}"\` — the link to navigate to this feature
- **List container**: \`data-testid="${ids.list}"\` — the main list/table element showing all records
- **Empty state**: \`data-testid="${ids.empty}"\` — shown when no records exist
- **Create button**: \`data-testid="${ids.create}"\` — the button to open the create form
- **Form container**: \`data-testid="${ids.form}"\` — the form element for create/edit
- **Submit button**: \`data-testid="${ids.submit}"\` — the submit button inside the form
- **Form fields**: Each NON-relationship field needs an \`<input>\` (or type-appropriate control) carrying \`data-testid\`:
${entity.fields
  .filter((f) => !entity.parents.some((p) => p.fkField === f.name))
  .map(
    (f) =>
      `  - \`data-testid="${ids.field(f.name)}"\` for the "${f.name}" field`
  )
  .join("\n")}${
    entity.parents.length > 0
      ? `\n  (Parent foreign-key fields — ${entity.parents.map((p) => `"${p.fkField}"`).join(", ")} — are NOT plain inputs; render them as \`<select>\` per **Relationship selectors** below.)`
      : ""
  }
- **Table row**: \`data-testid="${ids.row}"\` — each row in the list (use this as a prefix, e.g. in a \`data-testid\` attribute on the row container)
- **Row cells**: Each cell in a row needs \`data-testid\` for each of your entity's shows (${entity.shows.join(", ")}):
${entity.shows.map((s) => `  - \`data-testid="${ids.rowCell(s)}"\` for the "${s}" column`).join("\n")}
- **Row edit button**: \`data-testid="${ids.rowEdit}"\` — the edit action on each row
- **Row delete button**: \`data-testid="${ids.rowDelete}"\` — the delete action on each row
- **Delete confirm button**: \`data-testid="${ids.confirmDelete}"\` — put this on the BUTTON that actually performs the deletion (the one whose click fires the delete mutation), NOT on the dialog container/overlay. End-to-end acceptance CLICKS this testid to confirm the delete; if it sits on a wrapper \`<div>\` the click hits the backdrop, the delete never fires, and the row stays (delete acceptance fails).
${
  entity.parents.length > 0
    ? `- **Relationship selectors (parent foreign keys)**: each parent FK field MUST be a native \`<select>\` element — NOT an \`<input>\`, and not a custom combobox/autocomplete. Populate it with one \`<option>\` per existing parent record, where the option's \`value\` is the parent's \`id\`; fetch the parent list with its list query / api-client and map the rows to options. End-to-end acceptance picks a parent with Playwright \`selectOption\`, which ONLY works on a real \`<select>\` — an \`<input>\` (or non-native control) fails the create step and the feature parks at acceptance.\n${entity.parents.map((p) => `  - \`<select data-testid="${ids.field(p.fkField)}">\` — the "${p.fkField}" field: a list of ${p.key} records (each \`<option value={${p.key}.id}>\`)`).join("\n")}`
    : ""
}

${patternExample}

**Where to add them:**
- **Navigation (IMPORTANT — outside the feature directory):** add \`data-testid="${ids.nav}"\` to the "${entity.id}" link in the SHARED sidebar (\`apps/ui/src/components/core/AppSidebar/\`), NOT in the feature folder. A feature that isn't linked in the sidebar is unreachable and will fail end-to-end acceptance — every feature MUST be added to the sidebar navigation.
- List page component: add \`data-testid="${ids.list}"\` to the list/table container, \`data-testid="${ids.empty}"\` to the empty state
- Create button: add \`data-testid="${ids.create}"\` to the button that opens the form
- Form component: add \`data-testid="${ids.form}"\` to the \`<form>\`, \`data-testid="${ids.submit}"\` to the submit button, and \`data-testid="${ids.field("...")}\` to each field's control — an \`<input>\` for plain fields, a native \`<select>\` for a parent foreign-key field
- Table rows: add \`data-testid="${ids.row}"\` to each row container, \`data-testid="${ids.rowCell("...")}\` to data cells, \`data-testid="${ids.rowEdit}"\` and \`data-testid="${ids.rowDelete}"\` to action buttons
- Delete confirmation: add \`data-testid="${ids.confirmDelete}"\` to the CONFIRM BUTTON inside the delete dialog — the button whose \`onClick\` fires the delete mutation. NOT the dialog wrapper/overlay \`<div>\`: acceptance CLICKS this testid to confirm, and clicking a wrapper hits the backdrop, so the delete never runs and the row is never removed.

**Complete contract** (${required.length} required IDs):
${required.map((id) => `- \`${id}\``).join("\n")}

Without these test IDs, the feature cannot be validated end-to-end and will not be accepted.`;
}

/**
 * Check that a set of UI source files contain the required test ID markers.
 * Returns a list of missing testid values (empty array = all present, pass).
 *
 * Note: nav-<key> is NOT checked in the feature directory since it lives in the
 * shared sidebar. The nav reachability is already proven behaviorally by the E2E nav step.
 *
 * @param sources - Map of {filePath → source code}
 * @param entity - The entity whose testids must be present
 */
export function checkTestIds(
  sources: Map<string, string>,
  entity: IEntityAcceptance
): string[] {
  const errors: string[] = [];
  const source = Array.from(sources.values()).join("\n");
  const required = requiredTestIds(entity);
  const ids = testIdsFor(entity.key);

  for (const id of required) {
    // Skip nav ID check: it lives in shared sidebar, not the feature directory
    if (id === ids.nav) {
      continue;
    }

    // Match either quote style: the generated JSX is single-quoted
    // (`data-testid='x'`) after prettier/eslint, while hand-written examples
    // often use double quotes. Missing EITHER form means the hook is absent.
    const hasDouble = source.includes(`data-testid="${id}"`);
    const hasSingle = source.includes(`data-testid='${id}'`);

    if (!hasDouble && !hasSingle) {
      errors.push(id);
    }
  }

  return errors;
}
