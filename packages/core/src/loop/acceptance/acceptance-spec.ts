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

export function planToAcceptanceSpec(plan: IProductPlan): IAcceptanceSpec {
  const entities: IEntityAcceptance[] = plan.slices.map((slice, i) => {
    const fields: IAcceptField[] = slice.entity.fields.map((f) => ({
      name: f.name,
      type: f.type,
      optional: f.optional ?? false,
      valid: validValue(f, i + 1),
      invalid: [],
    }));

    // Parse parent relationships to get FK field names
    const parents = parseParents(slice.entity.relationships);

    // Add FK fields for each parent relationship (so the generator emits selectOption steps)
    // Only add if the field doesn't already exist in the entity's fields
    for (const parent of parents) {
      const fieldExists = fields.some((f) => f.name === parent.fkField);

      if (!fieldExists) {
        fields.push({
          name: parent.fkField,
          type: "string",
          optional: false,
          valid: `parent-${i + 1}`,
          invalid: [],
        });
      }
    }

    // FIX 8: Derive negatives from entity rules + parents + mustNotHappen constraints
    const negatives = negativesFor(slice.entity, fields, parents);

    // Add negatives from verification.mustNotHappen constraints
    // Map supported constraint patterns to negative cases (same shape as rule-derived negatives)
    for (const constraint of slice.verification.mustNotHappen) {
      // Extract patterns like "fieldName must not be empty/invalid"
      // Pattern: "fieldName must not X" or "cannot have fieldName as Y"
      const match =
        /^(\w+)\s+(must not|cannot)/i.exec(constraint.trim()) ??
        /cannot have (\w+)/i.exec(constraint.trim());

      if (match && typeof match[1] === "string") {
        const fieldName = match[1];
        const field = fields.find((f) => f.name === fieldName);

        // Only map real fields that exist and are required (optional fields don't get negatives)
        // For required non-FK fields, add an empty-value negative
        if (
          field &&
          !field.optional &&
          !parents.some((p) => p.fkField === field.name) &&
          !negatives.some((n) => n.field === fieldName && n.value === "")
        ) {
          negatives.push({
            field: fieldName,
            value: "",
            why: constraint,
          });
        }
      }
    }

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
  });

  return { entities };
}
