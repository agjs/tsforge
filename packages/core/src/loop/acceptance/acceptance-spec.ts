import type { IProductPlan, IEntitySpec } from "../planning/plan-types";
import type {
  IAcceptanceSpec,
  IEntityAcceptance,
  IAcceptField,
  IParentRef,
  INegativeCase,
  ITestIds,
} from "./acceptance.types";

function camel(s: string): string {
  if (s.length === 0) {
    return s;
  }

  const first = s.charAt(0);

  return first.toLowerCase() + s.slice(1);
}

export function testIdsFor(key: string): ITestIds {
  return {
    nav: `nav-${key}`,
    list: `${key}-list`,
    empty: `${key}-empty`,
    row: `${key}-row`,
    create: `${key}-create`,
    form: `${key}-form`,
    submit: `${key}-submit`,
    rowEdit: `${key}-row-edit`,
    rowDelete: `${key}-row-delete`,
    confirmDelete: `${key}-confirm-delete`,
    field: (name) => `${key}-field-${name}`,
    rowCell: (name) => `${key}-row-${name}`,
  };
}

// Deterministic valid sample per field, seeded off (entityIndex, fieldName) — no Date/random.
function validValue(
  field: { name: string; type: string },
  seed: number
): string {
  const isEmail = field.type === "email" || /email/i.test(field.name);

  if (isEmail) {
    return `user${seed}@example.com`;
  }

  if (field.type === "number") {
    return String(seed + 1);
  }

  if (/url|website/i.test(field.name)) {
    return `https://example${seed}.com`;
  }

  return `${field.name}-${seed}`;
}

function negativesFor(
  entity: IEntitySpec,
  fields: IAcceptField[],
  parents: IParentRef[] = []
): INegativeCase[] {
  const out: INegativeCase[] = [];

  // Collect the authoritative FK field names from parent references
  const fkFields = new Set(parents.map((p) => p.fkField));

  // Add negatives for required fields (empty/missing)
  // SKIP FK fields (relationship/select fields): they're tested via the positive create flow
  for (const f of fields) {
    // FIX 10: Use authoritative FK detection from parents, not endsWith('Id')
    const isForeignKey = fkFields.has(f.name);

    if (!isForeignKey && !f.optional) {
      out.push({ field: f.name, value: "", why: `${f.name} is required` });
    }

    if (!isForeignKey && (f.type === "email" || /email/i.test(f.name))) {
      out.push({
        field: f.name,
        value: "not-an-email",
        why: "invalid email must be rejected",
      });
    }

    if (!isForeignKey && f.type === "number") {
      out.push({
        field: f.name,
        value: "-1",
        why: "negative/invalid number must be rejected",
      });
    }
  }

  // Add negatives from entity's rules (explicit constraints)
  // ONLY if the constraint maps to an actual REQUIRED field in the entity
  for (const constraint of entity.rules) {
    // Extract common constraint patterns and try to find the field it references
    // Pattern: "fieldName must not be X", "fieldName cannot be Y"
    const match = /^(\w+)\s+(must not|cannot be)/i.exec(constraint.trim());

    if (match && typeof match[1] === "string") {
      const fieldName = match[1];
      const field = fields.find((f) => f.name === fieldName);

      // Only add empty-value negative for REQUIRED fields
      // Optional fields with constraints should not get a blanket empty-value negative
      if (field && !field.optional) {
        out.push({
          field: fieldName,
          value: "",
          why: constraint,
        });
      }
    }
  }

  return out;
}

function parseParents(relationships: readonly string[]): IParentRef[] {
  const out: IParentRef[] = [];

  for (const r of relationships) {
    const m = /^belongs\s*to\s+(\w+)/i.exec(r.trim());

    if (m !== null && typeof m[1] === "string") {
      const entity = m[1];

      out.push({ entity, key: camel(entity), fkField: `${camel(entity)}Id` });
    }
  }

  return out;
}

/**
 * Initialize acceptance fields from entity spec.
 */
function initializeFields(
  entityFields: IEntitySpec["fields"],
  index: number
): IAcceptField[] {
  return entityFields.map((f) => ({
    name: f.name,
    type: f.type,
    optional: f.optional ?? false,
    valid: validValue(f, index + 1),
    invalid: [],
  }));
}

/**
 * Add FK fields for parent relationships to ensure selectOption steps are generated.
 */
function addParentFkFields(
  fields: IAcceptField[],
  parents: IParentRef[],
  entityIndex: number
): void {
  for (const parent of parents) {
    const fieldExists = fields.some((f) => f.name === parent.fkField);

    if (!fieldExists) {
      fields.push({
        name: parent.fkField,
        type: "string",
        optional: false,
        valid: `parent-${entityIndex + 1}`,
        invalid: [],
      });
    }
  }
}

/**
 * Derive all negatives for an entity from rules and mustNotHappen constraints.
 */
function deriveNegatives(
  entity: IEntitySpec,
  fields: IAcceptField[],
  parents: IParentRef[],
  mustNotHappenConstraints: readonly string[]
): INegativeCase[] {
  const negatives = negativesFor(entity, fields, parents);

  for (const constraint of mustNotHappenConstraints) {
    addMustNotHappenNegatives(constraint, fields, parents, negatives);
  }

  return negatives;
}

/**
 * Build a single entity acceptance spec from a slice.
 */
function buildEntityAcceptance(
  slice: IProductPlan["slices"][number],
  index: number
): IEntityAcceptance {
  const fields = initializeFields(slice.entity.fields, index);
  const parents = parseParents(slice.entity.relationships);

  addParentFkFields(fields, parents, index);

  const negatives = deriveNegatives(
    slice.entity,
    fields,
    parents,
    slice.verification.mustNotHappen
  );

  return {
    id: slice.entity.id,
    key: camel(slice.entity.id),
    nav: slice.ui.nav,
    fields,
    shows: [...slice.ui.shows],
    screens: slice.ui.screens,
    parents,
    negatives,
    acceptanceCheck: slice.verification.acceptanceCheck,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Check if a field is mentioned (by exact name or humanized form) in a constraint.
 * Matches on WORD BOUNDARIES, not raw substring: a short field name like `id`/`age` must not
 * match a longer word that merely contains it (`valid`, `manage`), which would wrongly
 * associate the field with an unrelated constraint and fabricate a spurious negative test.
 */
export function fieldIsMentioned(
  field: IAcceptField,
  constraintLower: string
): boolean {
  const mentions = (needle: string): boolean =>
    needle.length > 0 &&
    new RegExp(`\\b${escapeRegExp(needle)}\\b`, "u").test(constraintLower);
  const humanized = field.name
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();

  return mentions(field.name.toLowerCase()) || mentions(humanized);
}

/**
 * Add constraint-specific negatives for a field.
 */
function addConstraintNegatives(
  field: IAcceptField,
  constraint: string,
  negatives: INegativeCase[]
): void {
  if (!field.optional) {
    const hasEmptyNegative = negatives.some(
      (n) => n.field === field.name && n.value === ""
    );

    if (!hasEmptyNegative) {
      negatives.push({
        field: field.name,
        value: "",
        why: constraint,
      });
    }
  }

  const invalidIndicators = [
    { pattern: /invalid\s+\w+/i, value: "invalid" },
    { pattern: /negative\s+\w+/i, value: "-1" },
  ];

  for (const { pattern, value } of invalidIndicators) {
    if (pattern.test(constraint)) {
      const hasValueNegative = negatives.some(
        (n) => n.field === field.name && n.value === value
      );

      if (!hasValueNegative) {
        negatives.push({
          field: field.name,
          value,
          why: constraint,
        });
      }
    }
  }
}

/**
 * Add negatives from mustNotHappen constraints using field-mention scan.
 */
function addMustNotHappenNegatives(
  constraint: string,
  fields: IAcceptField[],
  parents: IParentRef[],
  negatives: INegativeCase[]
): void {
  const constraintLower = constraint.toLowerCase();

  for (const field of fields) {
    if (parents.some((p) => p.fkField === field.name)) {
      continue;
    }

    if (fieldIsMentioned(field, constraintLower)) {
      addConstraintNegatives(field, constraint, negatives);
    }
  }
}

export function planToAcceptanceSpec(plan: IProductPlan): IAcceptanceSpec {
  const entities = plan.slices.map((slice, i) =>
    buildEntityAcceptance(slice, i)
  );

  return { entities };
}
