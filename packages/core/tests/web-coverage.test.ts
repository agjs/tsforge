import { test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entityNoun, uncoveredEntities } from "../src/web-coverage";

test("entityNoun strips the parenthetical + normalizes casing/separators", () => {
  expect(entityNoun("Organization (tenant)")).toBe("organization");
  expect(entityNoun("User (with Role: owner | admin | rep)")).toBe("user");
  expect(entityNoun("StockMovement (receipt | transfer)")).toBe(
    "stockmovement"
  );
  expect(entityNoun("Deal")).toBe("deal");
});

async function feature(
  dir: string,
  name: string,
  files: string[]
): Promise<void> {
  const f = join(dir, "src", "features", name);

  await mkdir(f, { recursive: true });

  for (const file of files) {
    await writeFile(join(f, file), "x");
  }
}

test("flags entities that are types-only (no .tsx) — the half-built-app gap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-cov-"));

  try {
    // account/contact = real UI; organization/note = types only (the gap).
    await feature(dir, "account", ["account.types.ts", "AccountsListPage.tsx"]);
    await feature(dir, "contact", [
      "contact.types.ts",
      "ContactCreatePage.tsx",
    ]);
    await feature(dir, "organization", ["organization.types.ts"]);
    await feature(dir, "note", ["note.types.ts", "note.service.ts"]);

    const missing = await uncoveredEntities(dir, [
      "Account",
      "Contact",
      "Organization (tenant)",
      "Note",
      "Tag", // no folder at all → also uncovered
    ]);

    expect(missing).toEqual(["Organization (tenant)", "Note", "Tag"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("all entities covered → empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-cov-"));

  try {
    await feature(dir, "deal", ["DealsListPage.tsx"]);
    await feature(dir, "stockmovement", ["StockMovementForm.tsx"]);

    expect(
      await uncoveredEntities(dir, ["Deal", "StockMovement (discriminated)"])
    ).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function route(dir: string, file: string): Promise<void> {
  const r = join(dir, "src", "routes");

  await mkdir(r, { recursive: true });
  await writeFile(join(r, file), "x");
}

test("route-based UI counts as covered (pages live in src/routes/, not features/)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-cov-"));

  try {
    // The layout that exposed the false-positive: entity pages as route files,
    // features/<entity>/ holds only types. Coverage must still see them.
    await route(dir, "accounts.tsx");
    await route(dir, "activities.create.tsx"); // plural y→ies must match "Activity"
    await feature(dir, "account", ["account.types.ts"]);
    await feature(dir, "tag", ["tag.types.ts"]); // types only → uncovered

    const missing = await uncoveredEntities(dir, [
      "Account",
      "Activity (call | email | meeting)",
      "Tag",
    ]);

    expect(missing).toEqual(["Tag"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a full noun is required — 'stage'/'table' files do NOT cover 'Tag'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-cov-"));

  try {
    await route(dir, "deals.tsx");
    await feature(dir, "deal", ["StageColumn.tsx"]); // contains "tag" as a substring

    expect(await uncoveredEntities(dir, ["Tag"])).toEqual(["Tag"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
