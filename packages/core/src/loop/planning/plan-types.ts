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

/** The modern-layout archetype VOCABULARY (roadmap) — intentionally broad so the model isn't
 *  locked into too few options. This tuple drives the `LayoutArchetype` type. It is NOT the set a
 *  plan may declare: plan validation gates on IMPLEMENTED_LAYOUT_ARCHETYPES (below), so a
 *  not-yet-built archetype is REJECTED, never silently accepted or fallen-back. Move an entry's
 *  behaviour into the wiring, add it to IMPLEMENTED_LAYOUT_ARCHETYPES, then plans can use it. */
export const LAYOUT_ARCHETYPES = [
  "app-sidebar", // left sidebar + header content shell (default SaaS look)
  "app-topnav", // horizontal top-nav + content
  "settings", // demoted secondary/config area (profile, account, prefs)
  "focused", // centered single-column (auth, onboarding)
  "public", // unauthenticated marketing/landing
] as const;

export type LayoutArchetype = (typeof LAYOUT_ARCHETYPES)[number];

/** The archetypes the harness actually IMPLEMENTS today — this drives PLAN VALIDATION. The full
 *  LAYOUT_ARCHETYPES set above is the roadmap/vocabulary; a plan may only DECLARE an implemented
 *  one. A not-yet-built archetype is rejected rather than silently mis-built — critically `public`
 *  implies UNAUTHENTICATED, but routing wraps every feature in ProtectedRoute+AppShell, so a
 *  silently-accepted `public` feature would be authenticated (wrong). Grow this set as archetypes
 *  ship. */
export const IMPLEMENTED_LAYOUT_ARCHETYPES = [
  "app-sidebar",
  "settings",
] as const;

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
