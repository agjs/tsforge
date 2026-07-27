import type { Exec, IExecResult } from "./exec";

/** A plain SQL identifier. The entity table name is the camelCased entity id
 *  (a validated PascalCase identifier upstream), so it is always alphanumerics —
 *  but guard anyway before it is ever interpolated into SQL. */
const SAFE_IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * True when `db:push` failed ONLY because drizzle-kit hit its INTERACTIVE column
 * resolver. When a plan drops the scaffold's stub `name` column and adds the real
 * domain columns (e.g. bookmarks: `title` + `url`, no `name`), drizzle-kit cannot
 * tell "rename `name`→`title`?" from "drop `name`, add `title`/`url`" and PROMPTS.
 * In the headless build (no TTY) that prompt throws "Interactive prompts require a
 * TTY terminal" and exits non-zero — and `--force` does NOT cover it (that flag only
 * auto-approves data-LOSS statements). The DB then never migrates: every runtime
 * query 500s (`column "title" does not exist`), create fails, and the feature is
 * hollow at runtime while the gate can false-green. Detect that specific failure so
 * we recover ONLY from it and never mask a genuinely broken schema.
 */
function isRenamePromptFailure(r: IExecResult): boolean {
  const text = `${r.stdout}\n${r.stderr}`;

  return (
    /Interactive prompts require a TTY/i.test(text) ||
    /promptColumnsConflicts|columnsResolver/.test(text)
  );
}

/**
 * Drop the build's entity table over the SAME connection `db:push` uses —
 * `DATABASE_URL` from the exec env, via the app's own `postgres` client (already a
 * dependency) — so the follow-up push does a clean CREATE instead of the ambiguous
 * rename ALTER. The build DB is disposable (holds no real data; the e2e reseeds), so
 * this is safe. No-op when `DATABASE_URL` is unset.
 */
async function dropEntityTable(
  apiCwd: string,
  exec: Exec,
  table: string
): Promise<void> {
  const script =
    `const p=(await import("postgres")).default;` +
    `const url=process.env.DATABASE_URL;` +
    `if(!url){process.exit(0);}` +
    `const sql=p(url);` +
    `try{await sql.unsafe('DROP TABLE IF EXISTS "app"."${table}" CASCADE');}` +
    `finally{await sql.end();}`;

  await exec(["bun", "-e", script], { cwd: apiCwd });
}

/**
 * Run BoringStack's `db:push -- --force`. If it fails ONLY because drizzle-kit hit
 * its interactive rename prompt (see {@link isRenamePromptFailure}), drop the build's
 * entity table and retry as a clean CREATE — the fix for the headless
 * schema-migration wall where a name-less plan removes the scaffold's stub `name`
 * column. Without `entityTable`, or for ANY other failure, this behaves exactly like
 * a plain push, so the caller's downstream gate still surfaces a genuinely broken
 * schema (the model's own compile error) instead of it being masked.
 */
export async function dbPushForce(
  apiCwd: string,
  exec: Exec,
  entityTable?: string
): Promise<IExecResult> {
  const first = await exec(["bun", "run", "db:push", "--", "--force"], {
    cwd: apiCwd,
  });

  if (first.code === 0) {
    return first;
  }

  if (
    entityTable === undefined ||
    !SAFE_IDENT.test(entityTable) ||
    !isRenamePromptFailure(first)
  ) {
    return first;
  }

  await dropEntityTable(apiCwd, exec, entityTable);

  return exec(["bun", "run", "db:push", "--", "--force"], { cwd: apiCwd });
}
