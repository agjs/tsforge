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
      ...optBool(f, "prodOnly"),
      ...optGenerate(f),
      ...optStrField(f, "envFile"),
    };
  });

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
): Readonly<Record<IArchetype, IArchetypeProfile>> {
  const node = raw.archetypes;

  if (!isRecord(node)) {
    throw new Error("scaffold manifest: archetypes missing");
  }

  const out: Record<string, IArchetypeProfile> = {};

  for (const name of ["astro", "boringstack"]) {
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
    };
  }

  return {
    astro: reqProfile(out, "astro"),
    boringstack: reqProfile(out, "boringstack"),
  };
}

function reqProfile(
  m: Record<string, IArchetypeProfile>,
  k: string
): IArchetypeProfile {
  const v = m[k];

  if (v === undefined) {
    throw new Error(`scaffold manifest: archetypes.${k} missing`);
  }

  return v;
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
