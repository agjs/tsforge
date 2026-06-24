import type {
  IConfigField,
  IEnvEdit,
  IScaffoldAnswers,
  IScaffoldManifest,
  IScaffoldPlan,
} from "./scaffold.types";

type IStack = IScaffoldAnswers["stack"];
type IEffective = (key: string) => string | readonly string[];

const ON_VALUES = new Set(["1", "true"]);
/** The env var that selects the stack — its value is the chosen STACK, not a field default. */
const STACK_KEY = "STACK";

/** Pure resolver: answers + manifest → the deterministic plan (env edits, container
 *  topology, conditional-required secrets, cross-rule violations). No I/O — Apply
 *  (`configure.ts`/`boot.ts`) executes the result. This is what the capability tests
 *  assert against. */
export function answersToPlan(
  manifest: IScaffoldManifest,
  answers: IScaffoldAnswers
): IScaffoldPlan {
  const isFull = answers.archetype === "boringstack";
  const effective = makeEffective(manifest, answers);
  const whenActive = makeWhenActive(effective);
  const services = computeServices(manifest, effective, isFull);
  const secrets = computeSecrets(
    manifest,
    effective,
    whenActive,
    answers.stack
  );

  return {
    archetype: answers.archetype,
    ref: manifest.defaultRef,
    renameArgs: manifest.renameParams.map((p) => {
      const v = answers.values[p];

      return typeof v === "string" ? v : "";
    }),
    envEdits: isFull
      ? computeEnvEdits(manifest, effective, answers, secrets.files)
      : [],
    services: [...services].sort(),
    requiredSecrets: isFull ? secrets.required : [],
    violations: isFull ? computeViolations(manifest, whenActive, services) : [],
  };
}

/** Resolve a field's value: explicit answer, else the stack default, else a
 *  kind-appropriate empty. */
function makeEffective(
  manifest: IScaffoldManifest,
  answers: IScaffoldAnswers
): IEffective {
  const byKey = new Map(manifest.fields.map((f) => [f.key, f]));

  return (key) => {
    const raw = answers.values[key];

    if (raw !== undefined) {
      return raw;
    }

    // STACK *is* the chosen stack — its env value tracks answers.stack, not the
    // field's per-stack default (which only carries dev). Otherwise `--stack prod`
    // wrote STACK= and `--stack smoke` wrote STACK=dev. An explicit --set wins above.
    if (key === STACK_KEY) {
      return answers.stack;
    }

    const field = byKey.get(key);

    if (field === undefined) {
      return "";
    }

    const def = answers.stack === "prod" ? field.prodDefault : field.devDefault;

    if (def !== undefined) {
      return def;
    }

    return field.kind === "multi" ? [] : field.kind === "toggle" ? "0" : "";
  };
}

/** The active value(s) a field contributes: for a toggle, the canonical on-tokens
 *  when on (else none); otherwise the chosen value(s). */
function activeValues(
  field: IConfigField,
  eff: string | readonly string[]
): readonly string[] {
  if (field.kind === "toggle") {
    return typeof eff === "string" && ON_VALUES.has(eff) ? ["1", "true"] : [];
  }

  return typeof eff === "string" ? [eff] : eff;
}

function computeServices(
  manifest: IScaffoldManifest,
  effective: IEffective,
  isFull: boolean
): Set<string> {
  const services = new Set<string>(isFull ? manifest.alwaysOnServices : []);

  if (!isFull) {
    return services;
  }

  for (const field of manifest.fields) {
    const map = field.addsServices;

    if (map === undefined) {
      continue;
    }

    for (const v of activeValues(field, effective(field.key))) {
      for (const svc of map[v] ?? []) {
        services.add(svc);
      }
    }
  }

  return services;
}

/** Required secrets + the env file each belongs in (the requiring field's resolved
 *  envFile) — so a user-supplied value (`--set RESEND_API_KEY=…`) is written to the
 *  right place. `required` is the surfaced checklist; `files` covers only the
 *  requiresSecrets-derived keys (generated secret FIELDS are emitted by envEditFor). */
interface ISecretInfo {
  readonly required: readonly string[];
  readonly files: ReadonlyMap<string, string>;
}

function computeSecrets(
  manifest: IScaffoldManifest,
  effective: IEffective,
  whenActive: (token: string) => boolean,
  stack: IStack
): ISecretInfo {
  const required = new Set<string>();
  const files = new Map<string, string>();

  for (const field of manifest.fields) {
    collectSecrets(field, effective(field.key), {
      whenActive,
      stack,
      manifest,
      into: required,
      files,
    });
  }

  return { required: [...required].sort(), files };
}

interface ICollectCtx {
  readonly whenActive: (token: string) => boolean;
  readonly stack: IStack;
  readonly manifest: IScaffoldManifest;
  readonly into: Set<string>;
  readonly files: Map<string, string>;
}

function collectSecrets(
  field: IConfigField,
  eff: string | readonly string[],
  ctx: ICollectCtx
): void {
  // A prod-only secret FIELD (JWT_SECRET, VALKEY_PASSWORD) is required in prod.
  if (
    field.kind === "secret" &&
    field.prodOnly === true &&
    ctx.stack === "prod"
  ) {
    ctx.into.add(field.key);
  }

  const map = field.requiresSecrets;

  if (map === undefined) {
    return;
  }

  // Infra secrets (GRAFANA/GLITCHTIP) are dev-auto-generated → only prod-required.
  if (field.requiresSecretsProdOnly === true && ctx.stack !== "prod") {
    return;
  }

  // Gated on an enabling toggle (AI provider keys only matter when AI_ENABLED).
  if (
    field.requiresSecretsWhen !== undefined &&
    !ctx.whenActive(field.requiresSecretsWhen)
  ) {
    return;
  }

  const file = fieldEnvFile(ctx.manifest, field, ctx.stack);

  for (const v of activeValues(field, eff)) {
    for (const secret of map[v] ?? []) {
      ctx.into.add(secret);
      ctx.files.set(secret, file); // where a supplied value should be written
    }
  }
}

/** The repo-relative env file a field's value (and its required secrets) target:
 *  the field's own `envFile`, else the group's, else the manifest default — with
 *  `${STACK}` resolved. */
function fieldEnvFile(
  manifest: IScaffoldManifest,
  field: IConfigField,
  stack: IStack
): string {
  const template =
    field.envFile ??
    manifest.envFileByGroup?.[field.group] ??
    manifest.envFileDefault ??
    "";

  return envFile(template, stack);
}

function computeEnvEdits(
  manifest: IScaffoldManifest,
  effective: IEffective,
  answers: IScaffoldAnswers,
  secretFiles: ReadonlyMap<string, string>
): readonly IEnvEdit[] {
  const edits: IEnvEdit[] = [];

  for (const field of manifest.fields) {
    const edit = envEditFor(
      field,
      effective(field.key),
      answers.stack,
      fieldEnvFile(manifest, field, answers.stack)
    );

    if (edit !== null) {
      edits.push(edit);
    }
  }

  // User-supplied required secrets (RESEND_API_KEY, OAuth creds, …): these aren't
  // manifest fields, so `--set KEY=value` is the only way to provide them. Write
  // each provided value to the requiring field's env file, flagged secret.
  for (const [key, file] of secretFiles) {
    const v = answers.values[key];

    if (typeof v === "string" && v.length > 0) {
      edits.push({ key, value: v, secret: true, file });
    }
  }

  return edits;
}

/** Resolve a `${STACK}` placeholder in an env-file path. The compose api service
 *  reads `api.dev.env` / `api.prod.env` by profile; `smoke` shares the dev file. */
function envFile(template: string, stack: IStack): string {
  const effective = stack === "smoke" ? "dev" : stack;

  return template.replace(/\$\{STACK\}/gu, effective);
}

function envEditFor(
  field: IConfigField,
  eff: string | readonly string[],
  stack: IStack,
  file: string
): IEnvEdit | null {
  if (field.kind === "multi") {
    return null; // enabled via per-option cred secrets, not a single env key
  }

  if (field.kind === "secret") {
    // Generated prod secrets become a secret edit (configure.ts fills the value).
    return field.prodOnly === true && stack === "prod"
      ? { key: field.key, value: "", secret: true, file }
      : null;
  }

  if (typeof eff !== "string") {
    return null;
  }

  return { key: field.key, value: eff, secret: false, file };
}

function makeWhenActive(effective: IEffective): (token: string) => boolean {
  const matches = (key: string, value: string): boolean => {
    const eff = effective(key);

    return typeof eff === "string" ? eff === value : eff.includes(value);
  };

  return (token) => {
    if (token.endsWith(":*")) {
      const eff = effective(token.slice(0, -2));

      return typeof eff === "string" ? ON_VALUES.has(eff) : eff.length > 0;
    }

    const [key, value] = token.split("=");

    return key !== undefined && value !== undefined && matches(key, value);
  };
}

function computeViolations(
  manifest: IScaffoldManifest,
  whenActive: (token: string) => boolean,
  services: ReadonlySet<string>
): readonly string[] {
  const violations: string[] = [];

  for (const rule of manifest.crossRules) {
    if (!whenActive(rule.when)) {
      continue;
    }

    const broken =
      rule.kind === "excludes"
        ? rule.then.some((t) => whenActive(t))
        : rule.then.some((t) => !thenSatisfied(t, whenActive, services));

    if (broken) {
      violations.push(rule.reason);
    }
  }

  return violations;
}

function thenSatisfied(
  token: string,
  whenActive: (t: string) => boolean,
  services: ReadonlySet<string>
): boolean {
  if (token.startsWith("service:")) {
    return services.has(token.slice("service:".length));
  }

  return whenActive(token);
}
