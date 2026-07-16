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

/** OPT-IN, stack-specific planning constraints for proposePlan. Absent → the
 *  planner is fully stack-agnostic (no extra guidance, no slice stripping). A
 *  stack that ships features (e.g. BoringStack auth) supplies these so the planner
 *  doesn't propose slices the stack already provides.
 *
 *  FAIL-CLOSED against silent truncation: this is a UNION, so `reservedEntities`
 *  can ONLY be set together with an `onStripped` reporter. It is a COMPILE error to
 *  request stripping without a way to surface the drops — the type makes a silent
 *  truncation unrepresentable, not merely discouraged. */
export type IPlanConstraints =
  | {
      /** Appended to the generic system prompt (e.g. "this stack already ships auth"). */
      readonly guidance?: string;
      readonly reservedEntities?: undefined;
      readonly onStripped?: undefined;
    }
  | {
      readonly guidance?: string;
      /** Entity ids to strip from the result (lowercased match). */
      readonly reservedEntities: ReadonlySet<string>;
      /** Called with the entity ids stripped from a proposed plan — REQUIRED
       *  whenever `reservedEntities` is set, so a drop is never silent. */
      readonly onStripped: (droppedEntityIds: readonly string[]) => void;
    };
