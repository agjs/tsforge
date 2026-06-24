import { randomBytes } from "node:crypto";
import type { IScaffoldFs, IScaffoldRunner } from "./io";
import type {
  IConfigField,
  IEnvEdit,
  IScaffoldManifest,
  IScaffoldPlan,
} from "./scaffold.types";

/** The fields of an env edit needed to write/summarize WITHIN one file (the target
 *  `file` is resolved by the caller, which groups edits per file first). */
export type IEnvWrite = Pick<IEnvEdit, "key" | "value" | "secret">;

/** A live `KEY=` assignment (ignoring leading whitespace) for a given key — NOT a
 *  match inside a `# … KEY=…` comment. boringstack documents toggles in comments,
 *  so we must edit only the real assignment line. */
function liveAssignment(line: string, key: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(key)}=`, "u").test(line);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Apply env edits to a `.env` body: replace the value of an existing live
 *  assignment in place, or append `KEY=value` if the key has no live assignment
 *  (a key that appears only in a comment counts as absent). Pure — returns the new
 *  text; never logs (callers must use {@link summarizeEnvEdits} for any output). */
export function applyEnvEdits(
  envText: string,
  edits: readonly IEnvWrite[]
): string {
  // Collapse to last-writer-wins per key, preserving first-seen order for appends.
  const resolved = new Map<string, string>();

  for (const e of edits) {
    resolved.set(e.key, e.value);
  }

  const lines = envText.split("\n");
  const written = new Set<string>();

  const next = lines.map((line) => {
    for (const [key, value] of resolved) {
      if (liveAssignment(line, key)) {
        written.add(key);

        return `${key}=${value}`;
      }
    }

    return line;
  });

  const appends = [...resolved]
    .filter(([key]) => !written.has(key))
    .map(([key, value]) => `${key}=${value}`);

  if (appends.length === 0) {
    return next.join("\n");
  }

  // Append after the existing body, avoiding a leading blank-line run.
  const body = next.join("\n").replace(/\n+$/u, "\n");

  return `${body}${appends.join("\n")}\n`;
}

const REDACTED = "••• (set, hidden)";

/** Human-readable lines for the edits. Secret VALUES are redacted (org rule:
 *  secrets are set on disk but NEVER echoed to logs); the key is still shown so
 *  the user knows it was configured. */
export function summarizeEnvEdits(edits: readonly IEnvWrite[]): string[] {
  return edits.map((e) =>
    e.secret ? `${e.key}=${REDACTED}` : `${e.key}=${e.value}`
  );
}

/** Generate a secret value for a manifest `generate` spec (`base64:N` → N random
 *  bytes, base64). Used to fill prod-only secret fields the user didn't supply. */
export function generateSecret(spec: string): string {
  const bytes = Number.parseInt(spec.split(":")[1] ?? "32", 10);

  return randomBytes(Number.isFinite(bytes) && bytes > 0 ? bytes : 32).toString(
    "base64"
  );
}

/** Dependencies for {@link applyScaffold} — abstracted so it's unit-testable. */
export interface IConfigureDeps {
  readonly run: IScaffoldRunner;
  readonly fs: IScaffoldFs;
  /** Secret generator (default uses crypto). Tests can stub for determinism. */
  readonly randSecret?: (spec: string) => string;
}

/** What configure did, for the handoff/summary (no secret values). */
export interface IConfigureResult {
  readonly commands: readonly string[];
  readonly filesWritten: readonly string[];
  readonly summary: readonly string[];
}

/**
 * Apply a resolved plan to a freshly-cloned boringstack: drive its OWN scripts
 * (`scripts/rename-project.sh`, `setup.sh`) then write the env edits to their target
 * files (seeding a file from its `.example` when absent), filling generate-spec
 * secrets. Mimics the real quickstart — tsforge reimplements none of boringstack's
 * setup. Astro (static site) takes no scripts/env. Secret values are written to
 * disk but NEVER returned in `summary` (org rule).
 */
export async function applyScaffold(
  dir: string,
  manifest: IScaffoldManifest,
  plan: IScaffoldPlan,
  deps: IConfigureDeps
): Promise<IConfigureResult> {
  if (plan.archetype !== "boringstack") {
    return { commands: [], filesWritten: [], summary: [] };
  }

  const { run, fs } = deps;
  const randSecret = deps.randSecret ?? generateSecret;
  const commands: string[] = [];

  // 1. Rename — only when every rename param was supplied.
  if (
    plan.renameArgs.length > 0 &&
    plan.renameArgs.every((a) => a.length > 0)
  ) {
    const argv = ["bash", "scripts/rename-project.sh", ...plan.renameArgs];

    await run(dir, argv);
    commands.push(argv.join(" "));
  }

  // 2. Bootstrap compose/.env (+ GlitchTip secret) via boringstack's setup.sh —
  //    WITHOUT --up, so booting stays a separate, explicit step (boot.ts).
  await run(dir, ["bash", "setup.sh"]);
  commands.push("bash setup.sh");

  // 3. Env edits, grouped per target file; seed a missing file from `.example`.
  const generateByKey = new Map(
    manifest.fields
      .filter(
        (f): f is IConfigField & { generate: string } =>
          f.kind === "secret" && f.generate !== undefined
      )
      .map((f) => [f.key, f.generate])
  );

  const byFile = new Map<string, IEnvEdit[]>();

  for (const edit of plan.envEdits) {
    const list = byFile.get(edit.file) ?? [];

    list.push(edit);
    byFile.set(edit.file, list);
  }

  const filesWritten: string[] = [];
  const summary: string[] = [];

  for (const [file, edits] of byFile) {
    if (file.length === 0) {
      continue;
    }

    const path = `${dir}/${file}`;
    const base = await readOrSeed(fs, path);

    const writes: IEnvWrite[] = edits.map((e) => {
      const spec = generateByKey.get(e.key);

      // Fill a generate-spec secret the plan left empty.
      if (e.secret && e.value.length === 0 && spec !== undefined) {
        return { key: e.key, value: randSecret(spec), secret: true };
      }

      return { key: e.key, value: e.value, secret: e.secret };
    });

    await fs.writeText(path, applyEnvEdits(base, writes));
    filesWritten.push(file);
    summary.push(`# ${file}`, ...summarizeEnvEdits(writes));
  }

  return { commands, filesWritten, summary };
}

/** Read a file, or seed it from a sibling `.example` (the quickstart's `cp`), or
 *  start empty. */
async function readOrSeed(fs: IScaffoldFs, path: string): Promise<string> {
  if (await fs.exists(path)) {
    return fs.readText(path);
  }

  const example = `${path}.example`;

  if (await fs.exists(example)) {
    return fs.readText(example);
  }

  return "";
}
