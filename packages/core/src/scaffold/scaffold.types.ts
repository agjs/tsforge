/**
 * Types for the greenfield scaffolding wizard. A source document (BoringStack's
 * committed `.tsforge/scaffold-manifest.json`, or tsforge's Phaser template
 * descriptor) declares the clone repo, gates, and — for BoringStack — the env
 * surface. Phaser is a second cloneable template, not a profile of the
 * fullstack manifest.
 */

/** Cloneable project types. `astro` / `boringstack` come from the BoringStack
 *  repo; `phaser` clones Phaser-TypeScript-AI-First-Starter. */
export const ARCHETYPES = ["astro", "boringstack", "phaser"] as const;

export type IArchetype = (typeof ARCHETYPES)[number];

export function isArchetype(value: string): value is IArchetype {
  for (const a of ARCHETYPES) {
    if (a === value) {
      return true;
    }
  }

  return false;
}

/** How a config field is collected + applied. Drives the wizard step kind and the
 *  `.env`/rename mapping. */
export type IConfigFieldKind =
  | "toggle" // boolean WITH_*/FEATURE flag → may add services (see addsServices)
  | "one-of" // a provider choice (EMAIL_PROVIDER ∈ {cloudflare,resend,…})
  | "multi" // an independent set (OAuth providers enabled)
  | "secret" // a value that must be set (never logged); often conditionalOn
  | "text"; // a free-text value (project name, domain, image owner)

/** A cross-field rule the wizard enforces before Apply. `implies` = selecting this
 *  requires another field/service; `excludes` = mutually exclusive (the
 *  "don't double-instrument" OTel↔Sentry case). Keys reference other field keys
 *  or option values (`field=value`). */
export interface IConfigCrossRule {
  readonly kind: "implies" | "excludes";
  readonly when: string; // e.g. "BILLING_ENABLED=true" or "oauth:google"
  readonly then: readonly string[]; // required fields/services, or excluded peers
  readonly reason: string; // shown to the model/user when the rule fires
}

/** One configurable in boringstack's surface, declared by the manifest. */
export interface IConfigField {
  /** The env var (or rename param) this controls, e.g. `WITH_OBSERVABILITY`. */
  readonly key: string;
  readonly kind: IConfigFieldKind;
  /** Wizard grouping for presentation: "infra" | "features" | "providers" | "identity". */
  readonly group: string;
  readonly label: string;
  readonly help?: string;
  /** Choices for `one-of`/`multi`. */
  readonly options?: readonly string[];
  /** Default values per STACK. A `toggle`/`one-of` default is the chosen value;
   *  for `multi` it's the enabled set. Absent → no default (must be answered). */
  readonly devDefault?: string | readonly string[];
  readonly prodDefault?: string | readonly string[];
  /** Compose services this field adds when ON / for a given option value. Keyed by
   *  the triggering value (`"1"`/`"true"` for toggles, the option for one-of). The
   *  topology = alwaysOnServices ∪ (matched addsServices). */
  readonly addsServices?: Readonly<Record<string, readonly string[]>>;
  /** Secrets this field's value makes REQUIRED (conditional-required), keyed by the
   *  triggering value. E.g. EMAIL_PROVIDER=resend → ["RESEND_API_KEY"]. */
  readonly requiresSecrets?: Readonly<Record<string, readonly string[]>>;
  /** When true, `requiresSecrets` are required ONLY in prod (dev auto-generates
   *  them — e.g. GRAFANA_ADMIN_PASSWORD / GlitchTip secrets). App-feature secrets
   *  (STRIPE, email, OAuth) are required whenever the field is on, regardless. */
  readonly requiresSecretsProdOnly?: boolean;
  /** Gate `requiresSecrets` on another field being active (a `field=value` or
   *  `field:*` token, same grammar as cross-rules). Use the `field:*` "is on" form
   *  for a toggle gate — the wizard records toggles as "1"/"0", so a literal
   *  `field=true` would never match a wizard answer. E.g. AI_PROVIDER's keys are
   *  required only when `AI_ENABLED:*`. Absent → always evaluated. */
  readonly requiresSecretsWhen?: string;
  /** Gate whether the WIZARD even ASKS this field on another field's answer, as a
   *  `KEY=value` token. The wizard records toggles as "1"/"0", so a field that only
   *  matters when a toggle is on uses `KEY=1` (e.g. CACHE_PROVIDER → `CACHE_ENABLED=1`).
   *  When the token doesn't match, the step is skipped and the planner falls back to
   *  the field's default. Absent → always asked. */
  readonly askWhen?: string;
  /** Only required when STACK=prod (e.g. JWT_SECRET, VALKEY_PASSWORD). */
  readonly prodOnly?: boolean;
  /** Generate via `openssl rand` rather than prompting (JWT_SECRET, MFA key). */
  readonly generate?: "base64:32" | "base64:48" | "base64:50";
  /** Which `.env` file (repo-relative) this field's value is written to. Infra
   *  toggles live in `infra/compose/compose/.env`; app features in `apps/api/.env`.
   *  Absent → the manifest's `envFileDefault`. */
  readonly envFile?: string;
}

/** Per-archetype build/gate profile. */
export interface IArchetypeProfile {
  /** Sub-path to extract from the boringstack clone (Astro = "apps/docs"); absent
   *  = use the whole repo (full boringstack). */
  readonly subPath?: string;
  /** The gate command run from the project (or per app) — the project's OWN
   *  checks, e.g. "bun run validate". For full-stack, one per app + a root drift
   *  check. */
  readonly gates: readonly { readonly cwd: string; readonly command: string }[];
  /** Template-only paths to DELETE from the clone after scaffolding this archetype
   *  (repo-relative). BoringStack ships its own docs site at `apps/docs`; a
   *  scaffolded product must not carry — or gate against — the template's docs, so
   *  the full-stack archetype strips it. Archetype-scoped on purpose: the `astro`
   *  archetype's product IS `apps/docs`, so it strips nothing. */
  readonly strip?: readonly string[];
  /** Scaffold-time boot command (full-stack only), e.g. "bash setup.sh --up". */
  readonly boot?: string;
  /** URLs to poll for readiness after boot (reuses scripts/boot-check pollUntilReady). */
  readonly healthUrls?: readonly string[];
}

/** The declarative manifest, committed in the boringstack repo and read after
 *  clone. Single source of truth for the config surface — evolving boringstack
 *  means editing THIS file, not tsforge. */
export interface IScaffoldManifest {
  readonly manifestVersion: number;
  /** Default git ref to clone (a tag once boringstack tags; a SHA until then). */
  readonly defaultRef: string;
  readonly repo: string; // e.g. "https://github.com/boringstack-xyz/boringstack"
  /** Positional args for scripts/rename-project.sh: project, ghcr-owner, domain. */
  readonly renameParams: readonly string[];
  /** Services always present regardless of toggles (postgres, valkey, api, ui, …). */
  readonly alwaysOnServices: readonly string[];
  /** Default repo-relative `.env` file for fields that don't resolve via
   *  `envFileByGroup` or a field `envFile` (e.g. `apps/api/.env`). */
  readonly envFileDefault?: string;
  /** Repo-relative `.env` file per field `group` — infra toggles/identity secrets
   *  live in `infra/compose/compose/.env`, app features in `apps/api/.env`. A field's
   *  own `envFile` overrides this; absent group falls back to `envFileDefault`. */
  readonly envFileByGroup?: Readonly<Record<string, string>>;
  /** Regex patterns (strings) for keys the completeness alarm WATCHES — a key in
   *  boringstack's `.env.example` matching one of these but absent from `fields`
   *  is a coverage gap (the wizard would silently drop a configurable). Defaults
   *  to ["^WITH_", "_ENABLED$"] when omitted. */
  readonly watchPatterns?: readonly string[];
  /** Regex patterns (strings) for watched keys the completeness alarm should
   *  deliberately IGNORE — test-only / internal toggles that are never scaffold
   *  questions (e.g. `E2E_TEST_ENDPOINTS_ENABLED`). Documents the exclusion so a
   *  watched key is either modelled or explicitly waived, never silently dropped. */
  readonly watchIgnore?: readonly string[];
  readonly fields: readonly IConfigField[];
  readonly crossRules: readonly IConfigCrossRule[];
  /** Profiles this source actually ships — a Phaser descriptor has only `phaser`;
   *  the BoringStack bundle has `astro` + `boringstack`. */
  readonly archetypes: Readonly<Partial<Record<IArchetype, IArchetypeProfile>>>;
}

/** The user's answers, keyed by field key. `toggle`/`one-of`/`text`/`secret` →
 *  string; `multi` → string[]. STACK is always present. */
export interface IScaffoldAnswers {
  readonly archetype: IArchetype;
  readonly stack: "dev" | "prod" | "smoke";
  readonly values: Readonly<Record<string, string | readonly string[]>>;
  /** Optional initial superuser seeded when the stack first boots (db:seed reads
   *  SUPERUSER_EMAIL/SUPERUSER_PASSWORD). Both must be set, or neither. */
  readonly superuser?: ISuperuser;
}

/** The initial admin login for a scaffolded project (boringstack only). */
export interface ISuperuser {
  readonly email: string;
  readonly password: string;
}

/** A single `.env` edit the plan will apply. */
export interface IEnvEdit {
  readonly key: string;
  readonly value: string;
  /** True when the value is secret — set on disk, NEVER echoed to logs. */
  readonly secret: boolean;
  /** Repo-relative `.env` file this edit targets (resolved from the field's
   *  `envFile` or the manifest's `envFileDefault`). Empty if neither is set. */
  readonly file: string;
}

/** The resolved, deterministic outcome of the answers — what Apply will do. Pure
 *  (no I/O), so it is fully unit-testable: the capability/topology/secrets tests
 *  assert against this. */
export interface IScaffoldPlan {
  readonly archetype: IArchetype;
  readonly ref: string;
  readonly renameArgs: readonly string[];
  readonly envEdits: readonly IEnvEdit[];
  /** Final container topology = alwaysOnServices ∪ toggled-on services, sorted. */
  readonly services: readonly string[];
  /** Secrets that must be provided/generated for this config (conditional-required). */
  readonly requiredSecrets: readonly string[];
  /** Cross-rule violations (non-empty = the plan is invalid and must not Apply). */
  readonly violations: readonly string[];
  /** Initial superuser to seed on first boot (carried through from the answers). */
  readonly superuser?: ISuperuser;
}
