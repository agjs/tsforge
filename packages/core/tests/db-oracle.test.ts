import { test, expect } from "bun:test";
import {
  expectedColumns,
  checkEntitySchema,
  schemaMismatchError,
} from "../src/loop/boringstack/db-oracle";
import type { Exec } from "../src/loop/boringstack/exec";
import type { IEntityAcceptance } from "../src/loop/boringstack/acceptance/acceptance.types";

/** A minimal plan-derived entity. `fields` already includes any parent-FK fields (the
 *  acceptance spec adds them), so this is exactly what the gate sees. */
function entityWith(key: string, fieldNames: string[]): IEntityAcceptance {
  return {
    id: key.charAt(0).toUpperCase() + key.slice(1),
    key,
    nav: `${key}s`,
    fields: fieldNames.map((name) => ({
      name,
      type: "string",
      optional: false,
      valid: `${name}-1`,
      invalid: [],
    })),
    shows: fieldNames,
    screens: ["list", "form"],
    parents: [],
    negatives: [],
    acceptanceCheck: `test ${key}`,
  };
}

/** An exec that answers the oracle's `bun -e` probe with a fixed column list (or a
 *  non-marker line to simulate an inconclusive read). */
function execReturningColumns(cols: string[] | "inconclusive"): Exec {
  return async (argv) => {
    const isProbe = argv[1] === "-e";

    if (isProbe && cols !== "inconclusive") {
      return {
        code: 0,
        stdout: `__ORACLE__${JSON.stringify(cols)}`,
        stderr: "",
      };
    }

    if (isProbe) {
      return { code: 0, stdout: "some unrelated output", stderr: "" };
    }

    return { code: 0, stdout: "", stderr: "" };
  };
}

test("expectedColumns = scaffold set ∪ plan fields", () => {
  const cols = expectedColumns(entityWith("bookmark", ["title", "url"]));

  expect(cols).toContain("id");
  expect(cols).toContain("user_id");
  expect(cols).toContain("created_at");
  expect(cols).toContain("updated_at");
  expect(cols).toContain("title");
  expect(cols).toContain("url");
});

test("checkEntitySchema: all plan columns present → ok, no missing", async () => {
  const exec = execReturningColumns([
    "id",
    "user_id",
    "title",
    "url",
    "created_at",
    "updated_at",
  ]);

  const r = await checkEntitySchema(
    "/api",
    exec,
    entityWith("bookmark", ["title", "url"])
  );

  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

test("checkEntitySchema: a missing plan column → NOT ok, names it (kills the #204 false-green)", async () => {
  // DB still has the stub `name`; the plan demands title + url. `url` never migrated.
  const exec = execReturningColumns([
    "id",
    "user_id",
    "name",
    "title",
    "created_at",
    "updated_at",
  ]);

  const r = await checkEntitySchema(
    "/api",
    exec,
    entityWith("bookmark", ["title", "url"])
  );

  expect(r.ok).toBe(false);
  expect(r.missing).toEqual(["url"]);
});

test("checkEntitySchema: extra columns do NOT fail (subset, not equality)", async () => {
  const exec = execReturningColumns([
    "id",
    "user_id",
    "title",
    "url",
    "created_at",
    "updated_at",
    "legacy_extra", // not in the plan — must be tolerated
  ]);

  const r = await checkEntitySchema(
    "/api",
    exec,
    entityWith("bookmark", ["title", "url"])
  );

  expect(r.ok).toBe(true);
});

test("checkEntitySchema: camel/snake tolerant (plan `companyId` ≡ DB `company_id`)", async () => {
  const exec = execReturningColumns([
    "id",
    "user_id",
    "company_id",
    "created_at",
    "updated_at",
  ]);

  const r = await checkEntitySchema(
    "/api",
    exec,
    entityWith("contact", ["companyId"])
  );

  expect(r.ok).toBe(true);
});

test("checkEntitySchema: inconclusive read (DB unreachable) NEVER blocks", async () => {
  const r = await checkEntitySchema(
    "/api",
    execReturningColumns("inconclusive"),
    entityWith("bookmark", ["title", "url"])
  );

  expect(r.ok).toBe(true);
  expect(r.actual).toBeNull();
});

test("checkEntitySchema: unsafe table name is never probed (returns non-blocking)", async () => {
  let probed = false;

  const exec: Exec = async (argv) => {
    if (argv[1] === "-e") {
      probed = true;
    }

    return { code: 0, stdout: "", stderr: "" };
  };

  const r = await checkEntitySchema(
    "/api",
    exec,
    entityWith("bad; DROP TABLE", ["x"])
  );

  expect(r.ok).toBe(true);
  expect(probed).toBe(false);
});

test("schemaMismatchError: actionable, names the missing columns + the schema file", () => {
  const e = schemaMismatchError(entityWith("bookmark", ["title", "url"]), {
    ok: false,
    missing: ["url"],
    actual: ["id", "user_id", "title", "created_at", "updated_at"],
  });

  expect(e.rule).toBe("db-schema-mismatch");
  expect(e.message).toContain("url");
  expect(e.message).toContain("app.schema.ts");
  expect(e.file).toContain("app.schema.ts");
});
