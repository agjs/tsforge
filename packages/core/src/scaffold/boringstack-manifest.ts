import { readFileSync } from "node:fs";
import { isRecord, isArray } from "../lib/guards";
import type {
  IArchetype,
  IArchetypeProfile,
  IConfigCrossRule,
  IConfigField,
  IConfigFieldKind,
  IScaffoldManifest,
} from "./scaffold.types";
import { ARCHETYPES, isArchetype } from "./scaffold.types";

let bundled: IScaffoldManifest | undefined;

/** The manifest bundled with tsforge — the bootstrap copy used to know boringstack's
 *  repo + defaultRef BEFORE cloning. Mirrors boringstack's `.tsforge/
 *  scaffold-manifest.json` (the source of truth); a guard test keeps them in sync,
 *  and post-clone the wizard can re-read the clone's copy for exact-commit fidelity.
 *  Parsed once (validated through {@link parseManifest}) and cached. */
export function loadBundledManifest(): IScaffoldManifest {
  bundled ??= parseManifest(
    JSON.parse(
      readFileSync(new URL("./scaffold-manifest.json", import.meta.url), "utf8")
    )
  );

  return bundled;
}

/** The recorded values a dependency field can actually take in the wizard's
 *  single-select state: a toggle stores "1"/"0"; a one-of stores one of its
 *  options. Anything else (multi lives in state.multi; secret/text/STACK are never
 *  single wizard answers) can never match, so it's not a valid askWhen target. */
function recordableValues(field: IConfigField): readonly string[] | null {
  if (field.key === "STACK") {
    return null; // STACK is not a wizard question
  }

  if (field.kind === "toggle") {
    return ["1", "0"];
  }

  if (field.kind === "one-of") {
    return field.options ?? [];
  }

  return null; // multi / secret / text never populate state.single
}

/** Fail loud on a malformed or dangerous `askWhen`: it must be exactly `KEY=value`
 *  (non-empty key and value, a single `=`), reference a real field asked EARLIER,
 *  not depend on a field that itself has an `askWhen` (chains would read a hidden
 *  field's stale answer), and name a value the dependency can actually record. A
 *  silent skip would apply the default forever, so this throws. */
function validateAskWhen(fields: readonly IConfigField[]): void {
  const byKey = new Map(fields.map((f, i) => [f.key, { field: f, index: i }]));
  const gated = new Set(
    fields.filter((f) => f.askWhen !== undefined).map((f) => f.key)
  );

  fields.forEach((field, i) => {
    const token = field.askWhen;

    if (token === undefined) {
      return;
    }

    const where = `fields[${String(i)}] (${field.key}).askWhen`;
    const eq = token.indexOf("=");

    if (eq <= 0 || eq !== token.lastIndexOf("=")) {
      throw new Error(
        `scaffold manifest: ${where} must be exactly "KEY=value" — got "${token}"`
      );
    }

    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);

    if (value.length === 0) {
      throw new Error(
        `scaffold manifest: ${where} has an empty value in "${token}"`
      );
    }

    const dep = byKey.get(key);

    if (dep === undefined) {
      throw new Error(
        `scaffold manifest: ${where} references unknown field "${key}"`
      );
    }

    if (dep.index >= i) {
      throw new Error(
        `scaffold manifest: ${where} references "${key}", which must be asked before it`
      );
    }

    if (gated.has(key)) {
      throw new Error(
        `scaffold manifest: ${where} depends on "${key}", which itself has askWhen — chained conditions are not supported`
      );
    }

    const valid = recordableValues(dep.field);

    if (valid === null) {
      throw new Error(
        `scaffold manifest: ${where} depends on "${key}", which is not a yes/no or single-choice wizard question (its answer never reaches the gate)`
      );
    }

    if (!valid.includes(value)) {
      throw new Error(
        `scaffold manifest: ${where} value "${value}" can never match "${key}" — expected one of ${valid.join(" | ")} (a toggle records "1"/"0", not "true")`
      );
    }
  });
}

/** Parse + validate the boringstack scaffold manifest (read from the cloned repo
 *  or a test fixture). Narrows `unknown` with guards (no casts); throws a clear
 *  error on malformed input so a bad manifest fails loudly rather than producing
 *  a half-formed wizard. */
export function parseManifest(raw: unknown): IScaffoldManifest {
  if (!isRecord(raw)) {
    throw new Error("scaffold manifest: expected a JSON object");
  }

  const fieldKinds = new Set<IConfigFieldKind>([
    "toggle",
    "one-of",
    "multi",
    "secret",
    "text",
  ]);

  const fields = reqArray(raw, "fields").map((f, i): IConfigField => {
    if (!isRecord(f)) {
      throw new Error(`scaffold manifest: fields[${String(i)}] not an object`);
    }

    const kind = str(f, "kind", `fields[${String(i)}]`);

    if (!fieldKinds.has(narrowKind(kind))) {
      throw new Error(
        `scaffold manifest: fields[${String(i)}] bad kind ${kind}`
      );
    }

    // askWhen must be a STRING when present. optStrField silently drops a non-string
    // (e.g. `askWhen: true`), which would leave the step unconditional — the opposite
    // of the fail-loud contract validateAskWhen enforces. Reject it here.
    if ("askWhen" in f && typeof f.askWhen !== "string") {
      throw new Error(
        `scaffold manifest: fields[${String(i)}] askWhen must be a string, got ${typeof f.askWhen}`
      );
    }

    return {
      key: str(f, "key", `fields[${String(i)}]`),
      kind: narrowKind(kind),
      group: str(f, "group", `fields[${String(i)}]`),
      label: str(f, "label", `fields[${String(i)}]`),
      ...optStr(f, "help"),
      ...optStrArr(f, "options"),
      ...optDefault(f, "devDefault"),
      ...optDefault(f, "prodDefault"),
      ...optRecordOfStrArr(f, "addsServices"),
      ...optRecordOfStrArr(f, "requiresSecrets"),
      ...optBool(f, "requiresSecretsProdOnly"),
      ...optStrField(f, "requiresSecretsWhen"),
      ...optStrField(f, "askWhen"),
      ...optBool(f, "prodOnly"),
      ...optGenerate(f),
      ...optStrField(f, "envFile"),
    };
  });

  // crossRules are the SAFETY validation (mutually-exclusive / implies checks
  // that assertValid enforces). optArray would silently coerce a wrong TYPE
  // (an object, string, null) to `[]` — defeating validation while the config
  // scaffolds as "valid". Present-but-not-an-array must fail loud, like every
  // other required field in this parser. (Absent → [] is fine.)
  if (raw.crossRules !== undefined && !isArray(raw.crossRules)) {
    throw new Error("scaffold manifest: crossRules must be an array");
  }

  const crossRules = optArray(raw, "crossRules").map(
    (r, i): IConfigCrossRule => {
      if (!isRecord(r)) {
        throw new Error(`scaffold manifest: crossRules[${String(i)}] bad`);
      }

      const kind = str(r, "kind", `crossRules[${String(i)}]`);

      if (kind !== "implies" && kind !== "excludes") {
        throw new Error(`scaffold manifest: crossRules[${String(i)}] bad kind`);
      }

      return {
        kind,
        when: str(r, "when", `crossRules[${String(i)}]`),
        then: strArr(r, "then", `crossRules[${String(i)}]`),
        reason: str(r, "reason", `crossRules[${String(i)}]`),
      };
    }
  );

  validateAskWhen(fields);

  return {
    manifestVersion: num(raw, "manifestVersion"),
    defaultRef: str(raw, "defaultRef", "manifest"),
    repo: str(raw, "repo", "manifest"),
    renameParams: strArr(raw, "renameParams", "manifest"),
    alwaysOnServices: strArr(raw, "alwaysOnServices", "manifest"),
    ...optStrField(raw, "envFileDefault"),
    ...optRecordOfStr(raw, "envFileByGroup"),
    ...optStrArr(raw, "watchPatterns"),
    ...optStrArr(raw, "watchIgnore"),
    fields,
    crossRules,
    archetypes: parseArchetypes(raw),
  };
}

function parseArchetypes(
  raw: Record<string, unknown>
): Readonly<Partial<Record<IArchetype, IArchetypeProfile>>> {
  const node = raw.archetypes;

  if (!isRecord(node)) {
    throw new Error("scaffold manifest: archetypes missing");
  }

  const names = Object.keys(node);

  if (names.length === 0) {
    throw new Error("scaffold manifest: archetypes is empty");
  }

  const out: Partial<Record<IArchetype, IArchetypeProfile>> = {};

  for (const name of names) {
    if (!isArchetype(name)) {
      throw new Error(
        `scaffold manifest: unknown archetype ${name} (${ARCHETYPES.join(" | ")})`
      );
    }

    const a = node[name];

    if (!isRecord(a)) {
      throw new Error(`scaffold manifest: archetypes.${name} missing`);
    }

    const gates = reqArray(a, "gates").map((g, i) => {
      if (!isRecord(g)) {
        throw new Error(`scaffold manifest: ${name}.gates[${String(i)}] bad`);
      }

      return {
        cwd: str(g, "cwd", `${name}.gates[${String(i)}]`),
        command: str(g, "command", `${name}.gates[${String(i)}]`),
      };
    });

    out[name] = {
      gates,
      ...optStrField(a, "subPath"),
      ...optStrField(a, "boot"),
      ...optStrArr(a, "healthUrls"),
      ...optStrArr(a, "strip"),
    };
  }

  return out;
}

function narrowKind(kind: string): IConfigFieldKind {
  switch (kind) {
    case "toggle":
    case "one-of":
    case "multi":
    case "secret":
    case "text":
      return kind;
    default:
      throw new Error(`scaffold manifest: unknown field kind ${kind}`);
  }
}

// --- narrowing helpers (no casts) ---
function str(o: Record<string, unknown>, k: string, ctx: string): string {
  const v = o[k];

  if (typeof v !== "string") {
    throw new Error(`scaffold manifest: ${ctx}.${k} must be a string`);
  }

  return v;
}

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];

  if (typeof v !== "number") {
    throw new Error(`scaffold manifest: ${k} must be a number`);
  }

  return v;
}

function reqArray(o: Record<string, unknown>, k: string): readonly unknown[] {
  const v = o[k];

  if (!isArray(v)) {
    throw new Error(`scaffold manifest: ${k} must be an array`);
  }

  return v;
}

function optArray(o: Record<string, unknown>, k: string): readonly unknown[] {
  return isArray(o[k]) ? reqArray(o, k) : [];
}

function strArr(o: Record<string, unknown>, k: string, ctx: string): string[] {
  return reqArray(o, k).map((v, i) => {
    if (typeof v !== "string") {
      throw new Error(
        `scaffold manifest: ${ctx}.${k}[${String(i)}] not a string`
      );
    }

    return v;
  });
}

function optStr(o: Record<string, unknown>, k: string): { help?: string } {
  return typeof o[k] === "string" ? { help: o[k] } : {};
}

// Building the single-key record via `out[k] = v` (rather than a `{ [k]: v }`
// literal) keeps the type as `Partial<Record<K, …>>`; a computed-key literal
// widens to `{ [x: string]: … }`, which TS won't assign back to the generic.
function optStrField<K extends string>(
  o: Record<string, unknown>,
  k: K
): Partial<Record<K, string>> {
  const v = o[k];
  const out: Partial<Record<K, string>> = {};

  if (typeof v === "string") {
    out[k] = v;
  }

  return out;
}

function optGenerate(o: Record<string, unknown>): {
  generate?: "base64:32" | "base64:48" | "base64:50";
} {
  const v = o.generate;

  if (v === "base64:32" || v === "base64:48" || v === "base64:50") {
    return { generate: v };
  }

  return {};
}

function optBool<K extends string>(
  o: Record<string, unknown>,
  k: K
): Partial<Record<K, boolean>> {
  const v = o[k];
  const out: Partial<Record<K, boolean>> = {};

  if (typeof v === "boolean") {
    out[k] = v;
  }

  return out;
}

function optStrArr<K extends string>(
  o: Record<string, unknown>,
  k: K
): Partial<Record<K, readonly string[]>> {
  const v = o[k];
  const out: Partial<Record<K, readonly string[]>> = {};

  if (isArray(v)) {
    out[k] = v.filter((x): x is string => typeof x === "string");
  }

  return out;
}

function optDefault<K extends string>(
  o: Record<string, unknown>,
  k: K
): Partial<Record<K, string | readonly string[]>> {
  const v = o[k];
  const out: Partial<Record<K, string | readonly string[]>> = {};

  if (typeof v === "string") {
    out[k] = v;
  } else if (isArray(v)) {
    out[k] = v.filter((x): x is string => typeof x === "string");
  }

  return out;
}

function optRecordOfStr<K extends string>(
  o: Record<string, unknown>,
  k: K
): Partial<Record<K, Readonly<Record<string, string>>>> {
  const v = o[k];
  const out: Partial<Record<K, Readonly<Record<string, string>>>> = {};

  if (!isRecord(v)) {
    return out;
  }

  const rec: Record<string, string> = {};

  for (const [key, val] of Object.entries(v)) {
    if (typeof val === "string") {
      rec[key] = val;
    }
  }

  out[k] = rec;

  return out;
}

function optRecordOfStrArr<K extends string>(
  o: Record<string, unknown>,
  k: K
): Partial<Record<K, Readonly<Record<string, readonly string[]>>>> {
  const v = o[k];
  const out: Partial<Record<K, Readonly<Record<string, readonly string[]>>>> =
    {};

  if (!isRecord(v)) {
    return out;
  }

  const rec: Record<string, readonly string[]> = {};

  for (const [key, val] of Object.entries(v)) {
    if (isArray(val)) {
      rec[key] = val.filter((x): x is string => typeof x === "string");
    }
  }

  out[k] = rec;

  return out;
}
