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
 * TTY terminal" — and `--force` does NOT cover it (that flag only auto-approves
 * data-LOSS statements). The DB then never migrates: every runtime query 500s
 * (`column "title" does not exist`), create fails, and the feature is hollow at
 * runtime while the gate false-greens.
 *
 * CRUCIALLY, `bun run db:push` exits 0 on this crash (the drizzle-kit rejection is
 * async and never propagates to the exit code — the same swallow that made the gate
 * false-green in the first place), so this MUST be detected by the output signature,
 * NOT the exit code. Detect that specific failure so we recover ONLY from it and
 * never mask a genuinely broken schema.
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

  // A failed drop is NOT fatal here: the follow-up push will simply hit the same
  // rename crash again, which {@link normalize} turns into a surfaced failure. So
  // swallow a throwing exec and let the retry be the single source of truth.
  try {
    await exec(["bun", "-e", script], { cwd: apiCwd });
  } catch {
    // ignore — the retry push reports the real outcome
  }
}

/**
 * A `db:push` that "exits 0" but whose output still carries the interactive-rename
 * crash did NOT migrate the DB — the async rejection was swallowed. Force such a
 * result to a non-zero code so callers (and the gate) can NEVER read it as success
 * and false-green on a stale DB. A clean result (no crash signature) is returned
 * unchanged; a result already non-zero stays non-zero.
 */
function normalize(r: IExecResult): IExecResult {
  if (isRenamePromptFailure(r) && r.code === 0) {
    return { ...r, code: 1 };
  }

  return r;
}

/**
 * Run BoringStack's `db:push -- --force`. If it fails ONLY because drizzle-kit hit
 * its interactive rename prompt (see {@link isRenamePromptFailure}), drop the build's
 * entity table and retry as a clean CREATE — the fix for the headless
 * schema-migration wall where a name-less plan removes the scaffold's stub `name`
 * column. Without `entityTable`, or for ANY other failure, this behaves exactly like
 * a plain push, so the caller's downstream gate still surfaces a genuinely broken
 * schema (the model's own compile error) instead of it being masked.
 *
 * The returned result's `code` is ALWAYS honest: a swallowed rename crash (code 0 +
 * signature) — whether on the first push with no recovery available, or on a retry
 * that STILL crashed (e.g. the drop was a no-op because DATABASE_URL was unset) — is
 * {@link normalize}d to a non-zero code, so a failed migration can never pass as
 * success.
 */
export async function dbPushForce(
  apiCwd: string,
  exec: Exec,
  entityTable?: string
): Promise<IExecResult> {
  const first = await exec(["bun", "run", "db:push", "--", "--force"], {
    cwd: apiCwd,
  });

  // Detect the crash by its OUTPUT, not the exit code: `bun run db:push` exits 0
  // even when drizzle-kit died at the interactive prompt (async rejection swallowed).
  // Only recover from THIS signature — any other outcome (real success, or a genuine
  // schema error the model must fix) is returned untouched (but still normalized so a
  // non-recoverable swallowed crash surfaces).
  if (
    entityTable === undefined ||
    !SAFE_IDENT.test(entityTable) ||
    !isRenamePromptFailure(first)
  ) {
    return normalize(first);
  }

  await dropEntityTable(apiCwd, exec, entityTable);

  const retry = await exec(["bun", "run", "db:push", "--", "--force"], {
    cwd: apiCwd,
  });

  return normalize(retry);
}
