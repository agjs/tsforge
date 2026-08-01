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

export interface IVerificationContract {
  readonly mustRemainTrue: readonly string[];
  readonly mustNotHappen: readonly string[]; // ≥1
  readonly acceptanceCheck: string; // runnable command, outcome-oriented
}

/**
 * A plan slice: a domain entity + its verification contract + a stack-specific UI intent. The core
 * spine is GENERIC over the UI-intent type `TUi` — core never names a concrete UI shape (screens,
 * nav, layout are WEB concepts). A stack adapter supplies the concrete `TUi` (BoringStack's
 * `IUiIntent`) and the schema that validates it (see `IPlanSchema`). `TUi = unknown` by default,
 * so a UI-agnostic caller sees `ui` as opaque rather than a hardcoded web shape.
 */
export interface ISlice<TUi = unknown> {
  readonly entity: IEntitySpec;
  readonly ui: TUi;
  readonly verification: IVerificationContract;
}

export interface IProductPlan<TUi = unknown> {
  readonly product: string; // one-paragraph purpose
  readonly slices: readonly ISlice<TUi>[];
}

/**
 * The STACK-SPECIFIC plan schema the generic planner + parser depend on, injected by the adapter
 * (BoringStack today). Core's `proposePlan` teaches `system` to the model, uses `example` to pin
 * the exact output shape, validates each slice's `ui` with `validateUi` at the parse boundary, and
 * applies the optional cross-slice `extraCheck`. This is what keeps the WEB plan shape (screens,
 * nav, layout, home) OUT of core — a Phaser adapter would supply its own schema, or a UI-less one
 * a trivial pass-through.
 */
export interface IPlanSchema<TUi> {
  /** System-prompt text teaching the model this stack's exact plan/UI shape. The adapter is
   *  responsible for embedding any worked example INTO this string (core only feeds `system` to
   *  the model) — so there is no separate `example` field to keep in sync. */
  readonly system: string;
  /** Validates a slice's `ui` field at the parse boundary (reject-by-default). */
  readonly validateUi: (value: unknown) => value is TUi;
  /** Optional cross-slice rule (e.g. "≤1 home"); returns false to reject the plan. Re-checked
   *  after reserved-slice stripping, so a transform can't leave the invariant false. */
  readonly extraCheck?: (plan: IProductPlan<TUi>) => boolean;
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
