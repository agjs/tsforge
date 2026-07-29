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

/** The modern-layout archetypes the harness understands. Intentionally broad so a plan is never
 *  locked into too few options; v1 IMPLEMENTS `app-sidebar` (the default) and `settings`, and the
 *  rest are schema-valid but fall back to `app-sidebar` + guidance until a build needs them (see
 *  the layout wiring in refine-prompt). Single source of truth: this tuple drives BOTH the
 *  `LayoutArchetype` type and the runtime validation list (plan-store), so they can't diverge. */
export const LAYOUT_ARCHETYPES = [
  "app-sidebar", // left sidebar + header content shell (default SaaS look)
  "app-topnav", // horizontal top-nav + content
  "settings", // demoted secondary/config area (profile, account, prefs)
  "focused", // centered single-column (auth, onboarding)
  "public", // unauthenticated marketing/landing
] as const;

export type LayoutArchetype = (typeof LAYOUT_ARCHETYPES)[number];

export interface IUiIntent {
  readonly screens: readonly ("list" | "detail" | "form" | "dashboard")[];
  readonly action: string; // primary user action → observable result
  readonly shows: readonly string[];
  readonly nav: string;
  /** Which layout archetype this feature's UI uses. Default `app-sidebar`. Drives sidebar
   *  grouping (primary app nav vs a demoted Settings group) — NOT a separate auth boundary in
   *  v1 (both stay ProtectedRoute + AppShell). */
  readonly layout?: LayoutArchetype;
  /** This feature's route is the post-login landing (the app "home"). At most ONE per plan; if
   *  none is marked, login falls back to the scaffold default (`/dashboard`). */
  readonly home?: boolean;
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
