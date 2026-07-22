import type { IProductPlan, IEntitySpec } from "../planning/plan-types";
import type {
  IAcceptanceSpec,
  IEntityAcceptance,
  IAcceptField,
  IParentRef,
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
 * Build a single entity acceptance spec from a slice.
 */
function buildEntityAcceptance(
  slice: IProductPlan["slices"][number],
  index: number
): IEntityAcceptance {
  const fields = initializeFields(slice.entity.fields, index);
  const parents = parseParents(slice.entity.relationships);

  addParentFkFields(fields, parents, index);

  return {
    id: slice.entity.id,
    key: camel(slice.entity.id),
    nav: slice.ui.nav,
    fields,
    shows: [...slice.ui.shows],
    screens: slice.ui.screens,
    parents,
    acceptanceCheck: slice.verification.acceptanceCheck,
  };
}

export function planToAcceptanceSpec(plan: IProductPlan): IAcceptanceSpec {
  const entities = plan.slices.map((slice, i) =>
    buildEntityAcceptance(slice, i)
  );

  return { entities };
}
