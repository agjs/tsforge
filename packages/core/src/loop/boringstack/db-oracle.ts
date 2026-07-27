import type { IEntityAcceptance } from "../acceptance/acceptance.types";
import type { IErrorItem } from "../../validate";
import type { Exec } from "./exec";

/**
 * DB boundary oracle — assert the OBSERVABLE end state, not the migration's story.
 *
 * A green `db:push` proves the command ran, NOT that Postgres actually holds the
 * schema the plan demands (see #200/#204: a swallowed crash exits 0, the DB never
 * migrates, every runtime query then 500s while the gate false-greens). This module
 * queries `information_schema.columns` after a successful push and asserts the plan's
 * columns are physically present. It is the 4-model panel's P0b — the primary runtime
 * truth-source.
 *
 * Contract:
 * - Expected columns are derived from the PLAN (the human-approved `IEntityAcceptance`),
 *   NEVER from the model's own schema file — otherwise it asserts against its own story.
 * - SUBSET, not equality: the scaffold/model may add extra columns; we only require the
 *   plan's columns to be present. Never fail on extras.
 * - PRESENCE of column names only; SQL type families are too coarse for the current plan
 *   types to assert reliably.
 * - Name matching is tolerant of camelCase vs snake_case (Drizzle emits `user_id` for the
 *   scaffold FK but domain columns often keep the field name as written), so both sides
 *   are normalized (strip `_`, lowercase) before comparison.
 * - INCONCLUSIVE (DB unreachable / query failed) never blocks: db:push just succeeded, so
 *   a read failure here is transient infra, not a model defect, and the full acceptance
 *   e2e remains the backstop. Only a SUCCESSFUL read with a missing plan column reds.
 */

/** The columns every scaffolded BoringStack entity table has, independent of the plan:
 *  the PK, the auth-owner FK, and timestamps. `belongs to User` maps to `user_id` here —
 *  it is never a plan field. */
const SCAFFOLD_COLUMNS: readonly string[] = [
  "id",
  "user_id",
  "created_at",
  "updated_at",
];

/** Normalize a column/field name so camelCase and snake_case compare equal
 *  (`userId` ≡ `user_id` ≡ `userid`). */
function normalizeCol(name: string): string {
  return name.replace(/_/g, "").toLowerCase();
}

/** A plain SQL identifier guard for the entity table name (defense-in-depth; the table is
 *  the camelCased plan id, already a validated PascalCase identifier upstream). */
const SAFE_TABLE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The columns the plan REQUIRES to physically exist for this entity: the scaffold set plus
 * every acceptance field (which already includes domain fields AND parent-FK fields, added
 * by `addParentFkFields`). Returned as raw names (for the error message); compare via
 * {@link normalizeCol}.
 */
export function expectedColumns(entity: IEntityAcceptance): string[] {
  return [...SCAFFOLD_COLUMNS, ...entity.fields.map((f) => f.name)];
}

/** Read the actual column names of `app.<table>` from `information_schema`, over the SAME
 *  `DATABASE_URL` the gate's db:push used (via the app's own `postgres` client). Returns
 *  the column list, or null when the read is INCONCLUSIVE (no DB url / query error) — the
 *  caller must treat null as "do not block". */
async function readActualColumns(
  apiCwd: string,
  exec: Exec,
  table: string
): Promise<string[] | null> {
  const script =
    `const p=(await import("postgres")).default;` +
    `const url=process.env.DATABASE_URL;` +
    `if(!url){console.log("__ORACLE__null");process.exit(0);}` +
    `const sql=p(url);` +
    `try{` +
    `const rows=await sql.unsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name=$1",[${JSON.stringify(table)}]);` +
    `console.log("__ORACLE__"+JSON.stringify(rows.map((r)=>r.column_name)));` +
    `}catch(e){console.log("__ORACLE__null");}finally{await sql.end();}`;

  const r = await exec(["bun", "-e", script], { cwd: apiCwd });
  const marker = /__ORACLE__(.+)/u.exec(`${r.stdout}\n${r.stderr}`);
  const payload = marker?.[1];

  if (payload === undefined) {
    return null; // couldn't read → inconclusive
  }

  try {
    const parsed: unknown = JSON.parse(payload);

    return Array.isArray(parsed)
      ? parsed.filter((c): c is string => typeof c === "string")
      : null;
  } catch {
    return null;
  }
}

export interface ISchemaCheck {
  /** false ONLY when the DB was read successfully and a plan column is absent. */
  readonly ok: boolean;
  /** Plan columns missing from the live table (raw names). Empty when ok or inconclusive. */
  readonly missing: readonly string[];
  /** Actual columns read, or null when the read was inconclusive (never blocks). */
  readonly actual: readonly string[] | null;
}

/**
 * Assert the live `app.<entity.key>` table contains every plan column. Non-blocking when
 * the DB read is inconclusive (returns ok:true, actual:null).
 */
export async function checkEntitySchema(
  apiCwd: string,
  exec: Exec,
  entity: IEntityAcceptance
): Promise<ISchemaCheck> {
  const table = entity.key;

  if (!SAFE_TABLE.test(table)) {
    return { ok: true, missing: [], actual: null };
  }

  const actual = await readActualColumns(apiCwd, exec, table);

  if (actual === null) {
    return { ok: true, missing: [], actual: null };
  }

  const present = new Set(actual.map(normalizeCol));
  const missing = expectedColumns(entity).filter(
    (c) => !present.has(normalizeCol(c))
  );

  return { ok: missing.length === 0, missing, actual };
}

/** Turn a failed schema check into an actionable gate error. The DB did NOT get the plan's
 *  columns even though db:push reported success — the API will 500 at runtime and the
 *  feature is hollow. Point the model at its Drizzle schema (the plan's source of truth). */
export function schemaMismatchError(
  entity: IEntityAcceptance,
  check: ISchemaCheck
): IErrorItem {
  return {
    key: `db-schema-mismatch:${entity.key}:${check.missing.join(",")}`,
    rule: "db-schema-mismatch",
    phase: 1,
    file: "apps/api/src/clients/postgres/schema/app.schema.ts",
    message:
      `db:push reported success but the live table \`app."${entity.key}"\` is MISSING ` +
      `plan column(s): ${check.missing.join(", ")}. The migration did not actually apply ` +
      `them, so the API will 500 at runtime (\`column "…" does not exist\`) and the feature ` +
      `is hollow — do NOT treat the gate as green. Add the missing column(s) to the ` +
      `\`${entity.key}\` Drizzle table in app.schema.ts (each plan field → a real column). ` +
      `Columns actually present: ${(check.actual ?? []).join(", ")}.`,
  };
}
