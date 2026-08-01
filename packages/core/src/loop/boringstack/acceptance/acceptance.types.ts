export interface IAcceptField {
  name: string;
  type: string;
  optional: boolean;
  valid: string;
  invalid: string[];
}

export interface IParentRef {
  entity: string;
  key: string;
  fkField: string;
}

export interface INegativeCase {
  field: string;
  value: string;
  why: string;
}

export interface IEntityAcceptance {
  id: string;
  key: string;
  nav: string;
  fields: IAcceptField[];
  shows: string[];
  // Screen ids the stack's UI intent declares — kept as opaque strings so core acceptance stays
  // generic over the UI shape (the web `list|detail|form|dashboard` values live in the adapter).
  screens: readonly string[];
  parents: IParentRef[];
  negatives: INegativeCase[];
  acceptanceCheck: string;
}

export interface IAcceptanceSpec {
  entities: IEntityAcceptance[];
}

export interface ITestIds {
  nav: string;
  list: string;
  empty: string;
  row: string;
  create: string;
  form: string;
  submit: string;
  rowEdit: string;
  rowDelete: string;
  confirmDelete: string;
  field(name: string): string;
  rowCell(name: string): string;
}

export type AcceptStep =
  "nav" | "list" | "create" | "persist" | "update" | "delete" | "negative";

export interface IAcceptanceResult {
  entity: string;
  step: AcceptStep;
  ok: boolean;
  detail: string;
}

export interface IAcceptanceOutcome {
  ok: boolean;
  results: IAcceptanceResult[];
  /** Short top-level summary of why acceptance failed. */
  detail?: string;
  infraError?: string;
}

export interface IAcceptanceRunCtx {
  cwd: string;
  apiBase: string;
  uiBase: string;
}

export interface IAcceptanceRunner {
  /** Run acceptance for a single entity.
   *  Optionally accepts the full spec for recursive parent seeding. When spec is provided,
   *  parent field metadata can be used to seed parents with real field values instead of
   *  placeholders. */
  run(
    entity: IEntityAcceptance,
    ctx: IAcceptanceRunCtx,
    spec?: IAcceptanceSpec
  ): Promise<IAcceptanceOutcome>;
  runChain(
    spec: IAcceptanceSpec,
    ctx: IAcceptanceRunCtx
  ): Promise<IAcceptanceOutcome>;
}
