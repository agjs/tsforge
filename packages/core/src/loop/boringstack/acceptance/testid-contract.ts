import ts from "typescript";
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
const TEST_FILE_RE = /\.(test|spec|stories)\.[jt]sx?$/u;

/** Parse a TS/TSX source into an AST (JSX enabled for .tsx/.jsx). */
function parseSource(path: string, src: string): ts.SourceFile {
  const kind =
    path.endsWith(".tsx") || path.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;

  return ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
}

/** Walk the AST once, recording which of `names` this file DECLARES (a `function useX`
 *  or `const useX =`) and which it CALLS (a real `CallExpression` on the bare identifier).
 *  AST-based on purpose: the name appearing in a comment, string, template, or regex
 *  literal is NOT a CallExpression, so those literal-form bypasses can't fake a call;
 *  and a call with explicit generics (`useX<A,B>()`) still has an Identifier callee, so
 *  it's matched (a regex on `useX\s*\(` would miss it). */
function hookUsage(
  sf: ts.SourceFile,
  names: ReadonlySet<string>
): { declares: Set<string>; calls: Set<string> } {
  const declares = new Set<string>();
  const calls = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      names.has(node.name.text)
    ) {
      declares.add(node.name.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      names.has(node.name.text)
    ) {
      declares.add(node.name.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text)
    ) {
      calls.add(node.expression.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  return { declares, calls };
}

/**
 * Detect a HOLLOW feature: the required test hooks are all present, but the CRUD
 * hooks are never CALLED from the UI — a static shell that satisfies the testid
 * contract while doing nothing (observed live: build49 Contact shipped every
 * `data-testid` with hardcoded `-` rows, no `onSubmit`, and `useCreate/Update/Delete`
 * defined but never called — a false-green the fast gate accepted).
 *
 * A hook is WIRED when it is actually INVOKED as a `CallExpression` in a non-test file
 * that does NOT declare it. Parsing to an AST (not regex) is deliberate: a mention in a
 * comment / string / template / **regex literal** is never a CallExpression, so none of
 * those literal forms can fake a call; an `import`/re-export/type-ref isn't a call either;
 * and a call with explicit generics (`useX<…>()`) is still matched. Passing both the
 * direct-call-in-page and the scaffold's view-hook idiom (the call living in a view
 * `<Component>.hooks.ts`) falls out naturally.
 *
 * @param files - Map of {relPath → source} for the feature's .ts + .tsx sources
 * @param entity - The entity whose CRUD hooks must be wired
 */
export function checkWiring(
  files: Map<string, string>,
  entity: IEntityAcceptance
): string[] {
  // The full-CRUD contract: the list query + the three mutation hooks the guide
  // mandates (list/create/update/delete). PascalCase feature id → hook names.
  const hooks = [
    `use${entity.id}`,
    `useCreate${entity.id}`,
    `useUpdate${entity.id}`,
    `useDelete${entity.id}`,
  ];
  const hookSet = new Set(hooks);
  const wired = new Set<string>();

  for (const [path, src] of files) {
    if (TEST_FILE_RE.test(path)) {
      continue;
    }

    const { declares, calls } = hookUsage(parseSource(path, src), hookSet);

    for (const name of calls) {
      // A call in a file that does NOT also declare the hook = real wiring (not recursion).
      if (!declares.has(name)) {
        wired.add(name);
      }
    }
  }

  return hooks.filter((h) => !wired.has(h));
}

/** Collect every value assigned to a REAL `data-testid` JSX attribute (AST-based, so a
 *  `data-testid` literal sitting in a comment or a plain string does NOT count — panel
 *  bypass). Handles `="x"`, `='x'`, `={"x"}`, and `={` + no-substitution-template. */
function collectJsxTestIds(sf: ts.SourceFile, out: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "data-testid") {
      const init = node.initializer;

      if (init !== undefined && ts.isStringLiteral(init)) {
        out.add(init.text);
      } else if (
        init !== undefined &&
        ts.isJsxExpression(init) &&
        init.expression !== undefined &&
        ts.isStringLiteralLike(init.expression)
      ) {
        out.add(init.expression.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
}

export function checkTestIds(
  sources: Map<string, string>,
  entity: IEntityAcceptance
): string[] {
  const ids = testIdsFor(entity.key);
  // nav lives in the shared sidebar, not the feature dir — never required here.
  const required = requiredTestIds(entity).filter((id) => id !== ids.nav);

  // Collect the testids that are REAL rendered JSX attributes (any file, any quote/brace
  // form) — a match inside a comment or a bare string is not a JsxAttribute, so it can't
  // satisfy the contract while the page stays a shell.
  const present = new Set<string>();

  for (const [path, src] of sources) {
    collectJsxTestIds(parseSource(path, src), present);
  }

  return required.filter((id) => !present.has(id));
}
