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
  screens: readonly ("list" | "detail" | "form" | "dashboard")[];
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
  | "nav"
  | "list"
  | "create"
  | "persist"
  | "update"
  | "delete"
  | "negative"
  | "relationship";

export interface IAcceptanceResult {
  entity: string;
  step: AcceptStep;
  ok: boolean;
  detail: string;
}

export interface IAcceptanceOutcome {
  ok: boolean;
  results: IAcceptanceResult[];
  infraError?: string;
}

export interface IAcceptanceRunCtx {
  cwd: string;
  apiBase: string;
  uiBase: string;
}

export interface IAcceptanceRunner {
  run(
    entity: IEntityAcceptance,
    ctx: IAcceptanceRunCtx
  ): Promise<IAcceptanceOutcome>;
  runChain(
    spec: IAcceptanceSpec,
    ctx: IAcceptanceRunCtx
  ): Promise<IAcceptanceOutcome>;
}
