export interface IEntitySpec {
  readonly id: string; // PascalCase, e.g. "Bookmark"
  readonly desc: string;
  readonly fields: readonly {
    name: string;
    type: string;
    optional?: boolean;
  }[];
  readonly relationships: readonly string[]; // e.g. "belongsTo User"
  readonly rules: readonly string[];
}

export interface IUiIntent {
  readonly screens: readonly ("list" | "detail" | "form" | "dashboard")[];
  readonly action: string; // primary user action → observable result
  readonly shows: readonly string[];
  readonly nav: string;
}

export interface IVerificationContract {
  readonly mustRemainTrue: readonly string[];
  readonly mustNotHappen: readonly string[]; // ≥1
  readonly acceptanceCheck: string; // runnable command, outcome-oriented
}

export interface ISlice {
  readonly entity: IEntitySpec;
  readonly ui: IUiIntent;
  readonly verification: IVerificationContract;
}

export interface IProductPlan {
  readonly product: string; // one-paragraph purpose
  readonly slices: readonly ISlice[];
}
