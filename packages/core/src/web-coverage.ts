import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Entity-coverage check — the completeness oracle for catalog builds. The gate
 * proves the app COMPILES and RENDERS, but not that the spec's entities actually
 * got built: a run greened with 4 of 8 entities (organization/user/note/tag) as
 * types-only — no components, no routes, no create button anywhere — because
 * nothing held the model to the declared entity list. This turns that list into
 * an enforced contract: every declared entity must have real UI (a feature folder
 * with ≥1 .tsx component), else the gate fails listing what's missing.
 */

/** The normalized core noun of a declared entity: "Organization (tenant)" →
 *  "organization", "StockMovement (receipt | …)" → "stockmovement". Strips the
 *  parenthetical, lowercases, drops non-alphanumerics (so casing/separators in a
 *  feature-folder name don't matter). */
export function entityNoun(raw: string): string {
  const before = raw.split("(")[0] ?? raw;

  return before.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Lowercased basenames of every `.tsx` under `src/routes` + `src/features` — the
 *  two places an entity's UI lives (a route PAGE like `routes/accounts.tsx`, or a
 *  feature component like `features/account/AccountCard.tsx`). We scan BOTH because
 *  the layout varies: some builds put pages in routes/, others in features/. We do
 *  NOT scan `src/components` (shared chrome) so a `UserMenu` avatar doesn't "cover"
 *  the User entity. */
async function uiBasenames(dir: string): Promise<string[]> {
  const out: string[] = [];

  const walk = async (d: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof readdir>>;

    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const p = join(d, entry.name);

      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.name.endsWith(".tsx")) {
        out.push(entry.name.toLowerCase());
      }
    }
  };

  await walk(join(dir, "src", "routes"));
  await walk(join(dir, "src", "features"));

  return out;
}

/** Does any UI basename belong to this entity? Matches the noun as a PREFIX
 *  (so "accounts.tsx"/"AccountsListPage.tsx" cover "account") and handles the
 *  common plurals (s, y→ies) — but requires the FULL noun, so "stage"/"table"
 *  never falsely cover "tag". */
function isCovered(basenames: readonly string[], noun: string): boolean {
  const stems = [noun, `${noun}s`];

  if (noun.endsWith("y")) {
    stems.push(`${noun.slice(0, -1)}ies`);
  }

  return basenames.some((name) => {
    const letters = name.replace(/[^a-z]/g, "");

    return stems.some((stem) => letters.startsWith(stem));
  });
}

/** Declared entities with NO built UI anywhere (no route page and no feature
 *  component) — the "types only, never built" gap. Returns the raw entity
 *  strings, in order. */
export async function uncoveredEntities(
  dir: string,
  entities: readonly string[]
): Promise<string[]> {
  const basenames = await uiBasenames(dir);

  return entities.filter((raw) => !isCovered(basenames, entityNoun(raw)));
}
