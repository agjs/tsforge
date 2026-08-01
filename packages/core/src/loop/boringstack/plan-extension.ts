import { isRecord, isArray } from "../../lib/guards";
import type { IProductPlan, IPlanSchema } from "../planning/plan-types";

/**
 * BoringStack's PLAN EXTENSION — the web/SaaS-specific UI-intent shape, its validator, and the
 * planner schema (prompt + example), kept OUT of the core plan spine. Core's `ISlice<TUi>` /
 * `IProductPlan<TUi>` are generic over the UI intent; core's `proposePlan` / `parsePlan` take an
 * injected `IPlanSchema<TUi>`. This file supplies the concrete `IUiIntent` BoringStack uses and
 * bundles everything into `boringstackPlanSchema`. A different adapter (a Phaser game) brings its
 * own, or a trivial UI-less schema.
 */

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

/** A fully-typed BoringStack plan: the generic core spine specialized to BoringStack's UI intent. */
export type BoringstackProductPlan = IProductPlan<IUiIntent>;

/**
 * Validate a slice's `ui` field is a well-formed `IUiIntent`: web screens, a non-empty action/nav,
 * a string `shows` list, an OPTIONAL layout that must be one the harness IMPLEMENTS (a not-yet-built
 * archetype like `public` is rejected, not silently mis-built), and an optional boolean `home`.
 */
export function isBoringstackUiIntent(value: unknown): value is IUiIntent {
  if (!isRecord(value)) {
    return false;
  }

  if (!isArray(value.screens)) {
    return false;
  }

  const validScreens = ["list", "detail", "form", "dashboard"];

  if (
    !value.screens.every(
      (s) => typeof s === "string" && validScreens.includes(s)
    )
  ) {
    return false;
  }

  if (typeof value.action !== "string" || value.action === "") {
    return false;
  }

  if (!isArray(value.shows)) {
    return false;
  }

  if (!value.shows.every((x) => typeof x === "string")) {
    return false;
  }

  if (typeof value.nav !== "string" || value.nav === "") {
    return false;
  }

  const validLayouts: readonly string[] = IMPLEMENTED_LAYOUT_ARCHETYPES;

  if (
    value.layout !== undefined &&
    !(typeof value.layout === "string" && validLayouts.includes(value.layout))
  ) {
    return false;
  }

  if (value.home !== undefined && typeof value.home !== "boolean") {
    return false;
  }

  return true;
}

/**
 * A complete, valid example plan shown to the model to pin the exact output shape. Typed as
 * IProductPlan<IUiIntent> (via `satisfies`) so the compiler guarantees the example we teach the
 * model is itself a legal plan; a regression test asserts it validates.
 */
export const PLANNER_EXAMPLE = {
  product:
    "A personal task tracker for a single user to capture and complete to-dos.",
  slices: [
    {
      entity: {
        id: "Task",
        desc: "A single to-do item owned by a user.",
        fields: [
          { name: "title", type: "string" },
          { name: "done", type: "boolean" },
          { name: "dueDate", type: "Date", optional: true },
        ],
        relationships: ["belongs to a User"],
        rules: ["title must not be empty", "a user only sees their own tasks"],
      },
      ui: {
        screens: ["list", "detail", "form"],
        action: "create, complete, and delete tasks",
        shows: ["title", "done", "dueDate"],
        nav: "Tasks",
        layout: "app-sidebar",
        home: true,
      },
      verification: {
        mustRemainTrue: ["only the owner can see or change a task"],
        mustNotHappen: ["a user must not see another user's tasks"],
        acceptanceCheck: "bun test",
      },
    },
  ],
} satisfies IProductPlan<IUiIntent>;

/**
 * System prompt for the product architect role: turn a product description + optional mockups into
 * a structured product plan (domain model + slices + UI + verification). The schema is pinned with
 * EXACT key names and a flat screen enum, plus the worked PLANNER_EXAMPLE, because a loosely-
 * described shape lets a model invent its own keys the strict parser then rejects.
 */
export const PLANNER_SYSTEM = `You are a product architect. From the product description and any mockups, propose a domain model as feature slices (one per entity). Respond with ONLY a JSON object — no prose, no markdown fences — matching this schema EXACTLY. Use these exact key names and value shapes; do not add, rename, or nest differently.

Schema:
{
  "product": "<one short paragraph: what the product is for>",
  "slices": [
    {
      "entity": {
        "id": "<PascalCase noun, e.g. Bookmark>",
        "desc": "<one line>",
        "fields": [ { "name": "<camelCase>", "type": "<string|number|boolean|Date|string[]>", "optional": <true if omittable, else omit this key> } ],
        "relationships": [ "<plain-English sentence, e.g. 'belongs to a User'>" ],
        "rules": [ "<plain-English invariant, e.g. 'title must not be empty'>" ]
      },
      "ui": {
        "screens": [ <any of "list", "detail", "form", "dashboard" — these EXACT lowercase words only, nothing else> ],
        "action": "<the primary thing a user does, one line>",
        "shows": [ "<field or thing shown on screen>" ],
        "nav": "<navigation label, e.g. Bookmarks>",
        "layout": "<OPTIONAL: app-sidebar (default) | settings — where this feature lives in the app shell. These are the only accepted values right now; other archetypes are roadmap-only and rejected>",
        "home": <OPTIONAL boolean: true on the ONE feature that is the app's main landing page after login (omit on the rest)>
      },
      "verification": {
        "mustRemainTrue": [ "<invariant that must always hold>" ],
        "mustNotHappen": [ "<at least one thing that must never happen>" ],
        "acceptanceCheck": "<a shell command that verifies the slice, e.g. bun test>"
      }
    }
  ]
}

Rules for the JSON:
- "screens" is a flat array of the literal words list/detail/form/dashboard ONLY — never objects, never other words.
- "relationships" and "rules" are arrays of plain STRINGS, never objects.
- "fields" uses "optional" (boolean), never "required".
- Use "desc" (not "description"), "action" (not "primaryAction"), "nav" (not "navigationLabel"), "acceptanceCheck" (not "acceptanceCheckCommand").
- "mustNotHappen" must have at least one entry.
- LAYOUT: give the app a real shape. Mark the ONE primary feature the user should land in with "home": true and "layout": "app-sidebar" (the app opens there, not on a generic dashboard). Put configuration/account features (profile, preferences, billing) at "layout": "settings" so they're grouped as a demoted settings area, not the main app. Most product features are "app-sidebar" (the default — you may omit "layout"). Use "home"/"layout" only from the allowed set above; never invent other values.

Complete example (follow this shape precisely):
${JSON.stringify(PLANNER_EXAMPLE, null, 2)}`;

/**
 * BoringStack's plan schema, injected into core's generic planner + parser: the web UI-schema
 * prompt, the worked example, the `ui` validator, and the cross-slice rule that at most ONE slice
 * is the app home (the post-login landing).
 */
export const boringstackPlanSchema: IPlanSchema<IUiIntent> = {
  // PLANNER_SYSTEM already embeds the serialized PLANNER_EXAMPLE, so the seam needs no separate
  // example field. PLANNER_EXAMPLE stays exported for its own regression test.
  system: PLANNER_SYSTEM,
  validateUi: isBoringstackUiIntent,
  extraCheck: (plan) =>
    plan.slices.filter((s) => s.ui.home === true).length <= 1,
};

/**
 * The SAME schema, TYPE-ERASED to `IPlanSchema<unknown>` for the heterogeneous `IStackAdapter`
 * registry (a concrete `IPlanSchema<IUiIntent>` isn't assignable to `IPlanSchema<unknown>` because
 * `extraCheck`'s parameter is contravariant). `validateUi` erases directly (a `v is IUiIntent`
 * guard satisfies `v is unknown`); `extraCheck` re-narrows each slice's opaque `ui` with the same
 * guard, so the runtime behaviour is identical. The typed `boringstackPlanSchema` stays for the
 * BoringStack build path, which needs `IProductPlan<IUiIntent>`.
 */
export const boringstackPlanSchemaErased: IPlanSchema<unknown> = {
  system: PLANNER_SYSTEM,
  validateUi: isBoringstackUiIntent,
  extraCheck: (plan) =>
    plan.slices.filter((s) => isBoringstackUiIntent(s.ui) && s.ui.home === true)
      .length <= 1,
};

/**
 * Extract the acceptance UI fields (nav / shows / screens) from a BoringStack UI intent — the
 * injected seam for the generic `planToAcceptanceSpec`, so the web UI shape stays out of core's
 * acceptance generator.
 */
export const boringstackUiFields = (
  ui: IUiIntent
): { nav: string; shows: readonly string[]; screens: readonly string[] } => ({
  nav: ui.nav,
  shows: ui.shows,
  screens: ui.screens,
});
