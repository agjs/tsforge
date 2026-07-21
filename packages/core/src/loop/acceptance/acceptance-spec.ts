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
  _entity: IEntitySpec,
  fields: IAcceptField[]
): INegativeCase[] {
  const out: INegativeCase[] = [];

  for (const f of fields) {
    if (!f.optional) {
      out.push({ field: f.name, value: "", why: `${f.name} is required` });
    }

    if (f.type === "email" || /email/i.test(f.name)) {
      out.push({
        field: f.name,
        value: "not-an-email",
        why: "invalid email must be rejected",
      });
    }

    if (f.type === "number") {
      out.push({
        field: f.name,
        value: "-1",
        why: "negative/invalid number must be rejected",
      });
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

    return {
      id: slice.entity.id,
      key: camel(slice.entity.id),
      nav: slice.ui.nav,
      fields,
      shows: [...slice.ui.shows],
      screens: slice.ui.screens,
      parents: parseParents(slice.entity.relationships),
      negatives: negativesFor(slice.entity, fields),
      acceptanceCheck: slice.verification.acceptanceCheck,
    };
  });

  return { entities };
}
