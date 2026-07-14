import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { toCamelCase } from "./case";
import { isRecord } from "../../lib/guards";

/** The `export { … } from "…/schema"` block in `tests/helpers/db.ts` closes with
 *  this line. A new resource's table must be added to that block or a test can't
 *  reference it: the `no-direct-db-in-tests` rule forbids importing the table from
 *  the schema directly, so the sanctioned helper is the ONLY legal source. */
const SCHEMA_REEXPORT_ANCHOR = '} from "../../src/clients/postgres/schema";';

function insertBeforeLast(
  src: string,
  anchor: string,
  insertion: string
): string {
  const index = src.lastIndexOf(anchor);

  if (index === -1) {
    throw new Error(`Anchor not found: ${anchor}`);
  }

  return src.slice(0, index) + insertion + src.slice(index);
}

export function wireRoutesFile(src: string, name: string): string {
  const camel = toCamelCase(name);
  const importLine = `import ${camel}Routes from "../../api/${camel}/${camel}.routes";\n`;
  const objectEntry = `  ${camel}: ${camel}Routes,\n`;

  const lastImportIndex = src.lastIndexOf("import ");

  if (lastImportIndex === -1) {
    throw new Error("No import statement found");
  }

  const importEndIndex = src.indexOf("\n", lastImportIndex);

  if (importEndIndex === -1) {
    throw new Error("No newline after import found");
  }

  const afterImports =
    src.slice(0, importEndIndex + 1) +
    importLine +
    src.slice(importEndIndex + 1);

  return insertBeforeLast(afterImports, "};", objectEntry);
}

export function wireAppFile(src: string, name: string): string {
  const camel = toCamelCase(name);
  const groupCall = `.group("/api/v1/${camel}", (group) => group.use(routes.${camel}))\n  `;

  return insertBeforeLast(src, ");", groupCall);
}

export function wireSwaggerFile(src: string, name: string): string {
  const tagEntry = `{ name: "${name}", description: "${name} resource" },\n    `;

  return insertBeforeLast(src, "],", tagEntry);
}

/**
 * Add the new resource's Drizzle table to the schema re-export block in
 * `tests/helpers/db.ts` — the canonical, gate-sanctioned way a test references a
 * table. Without this the model is trapped: `no-direct-db-in-tests` rejects the
 * schema import, but the helper doesn't expose the table either. Idempotent: if
 * the table is already listed, the source is returned unchanged.
 */
export function wireTestHelperFile(src: string, name: string): string {
  const camel = toCamelCase(name);
  const entry = `  ${camel},\n`;

  const anchorIndex = src.lastIndexOf(SCHEMA_REEXPORT_ANCHOR);

  if (anchorIndex === -1) {
    throw new Error(`Anchor not found: ${SCHEMA_REEXPORT_ANCHOR}`);
  }

  // Only guard against a duplicate WITHIN the re-export block (the same name may
  // legitimately appear elsewhere, e.g. a type re-export line).
  const blockStart = src.lastIndexOf("export {", anchorIndex);
  const block = src.slice(blockStart, anchorIndex);

  if (block.includes(entry.trimEnd())) {
    return src;
  }

  return insertBeforeLast(src, SCHEMA_REEXPORT_ANCHOR, entry);
}

/**
 * Register a generated UI feature's page in the SPA router (`app/router/routes.tsx`).
 * boringstack's `new:feature` deliberately leaves routing manual ("Next: register
 * the route in src/app/router/routes.tsx"), so without this the page is built and
 * gate-green but UNREACHABLE — no URL, no nav (observed live: a verified Bookmark
 * feature had no route). This is the UI analog of `wireRoutesFile`. It adds a lazy
 * import + an authenticated route object (same ProtectedRoute/AppShell/Suspense
 * wrapper the other feature routes use) at path `/<camel>`. Idempotent: if the
 * page is already imported, the source is returned unchanged. Pure — unit-tested.
 */
export function wireUiRouteFile(src: string, name: string): string {
  const camel = toCamelCase(name);
  const Name = camel.charAt(0).toUpperCase() + camel.slice(1);
  const importPath = `@/features/${camel}/components/${Name}Page/${Name}Page`;

  // Idempotent (retry-safe): already wired.
  if (src.includes(importPath)) {
    return src;
  }

  const anchor = "createBrowserRouter([";
  const anchorIndex = src.indexOf(anchor);

  if (anchorIndex === -1) {
    throw new Error(`Anchor not found: ${anchor}`);
  }

  const lazyConst =
    `const ${Name}Page = lazy(() =>\n` +
    `  import("${importPath}").then((m) => ({\n` +
    `    default: m.${Name}Page\n` +
    `  }))\n` +
    `);\n\n`;

  const routeObject =
    `\n  {\n` +
    `    path: "/${camel}",\n` +
    `    element: (\n` +
    `      <ProtectedRoute>\n` +
    `        <AppShell>\n` +
    `          <Suspense fallback={<Fallback />}>\n` +
    `            <${Name}Page />\n` +
    `          </Suspense>\n` +
    `        </AppShell>\n` +
    `      </ProtectedRoute>\n` +
    `    )\n` +
    `  },`;

  // Insert the route object as the first entry of the router array (a distinct
  // path — order is irrelevant and it never disturbs a trailing catch-all).
  const afterAnchor = anchorIndex + anchor.length;
  const withRoute =
    src.slice(0, afterAnchor) + routeObject + src.slice(afterAnchor);

  // Declare the lazy page const on the line just before the router statement
  // (all the other lazy consts sit there too).
  const routerLineStart =
    withRoute.lastIndexOf("\n", withRoute.indexOf(anchor)) + 1;

  return (
    withRoute.slice(0, routerLineStart) +
    lazyConst +
    withRoute.slice(routerLineStart)
  );
}

export async function wireResource(cwd: string, name: string): Promise<void> {
  const routesPath = join(cwd, "apps/api/src/config/routes/routes.ts");
  const appPath = join(cwd, "apps/api/src/config/app/app.ts");
  const swaggerPath = join(cwd, "apps/api/src/config/swagger/swagger.ts");

  const routesSrc = await readFile(routesPath, "utf-8");
  const appSrc = await readFile(appPath, "utf-8");
  const swaggerSrc = await readFile(swaggerPath, "utf-8");

  const routesResult = wireRoutesFile(routesSrc, name);
  const appResult = wireAppFile(appSrc, name);
  const swaggerResult = wireSwaggerFile(swaggerSrc, name);

  await writeFile(routesPath, routesResult, "utf-8");
  await writeFile(appPath, appResult, "utf-8");
  await writeFile(swaggerPath, swaggerResult, "utf-8");

  // 4th wiring edit: expose the new table through the test helper so a test can
  // reference it without tripping `no-direct-db-in-tests`. Guarded by existence —
  // a boringstack variant without this helper simply skips it (the other rules
  // then govern), rather than crashing the whole generate step.
  const testHelperPath = join(cwd, "apps/api/tests/helpers/db.ts");

  if (existsSync(testHelperPath)) {
    const testHelperSrc = await readFile(testHelperPath, "utf-8");

    await writeFile(
      testHelperPath,
      wireTestHelperFile(testHelperSrc, name),
      "utf-8"
    );
  }
}

/**
 * Register a generated UI feature in the SPA router so it is actually reachable.
 * Guarded by existence: a boringstack variant without this exact router file simply
 * skips (the page still builds; it just isn't auto-routed) rather than crashing the
 * generate step. Idempotent via `wireUiRouteFile`.
 */
export async function wireUiFeature(cwd: string, name: string): Promise<void> {
  const routesPath = join(cwd, "apps/ui/src/app/router/routes.tsx");

  if (existsSync(routesPath)) {
    const src = await readFile(routesPath, "utf-8");

    await writeFile(routesPath, wireUiRouteFile(src, name), "utf-8");
  }

  await wireI18nKeys(cwd, name);
}

/**
 * Seed the i18n keys the generated feature page renders (`features.<lower>.title`
 * and `.empty`) into every locale's `common.json`. new:feature emits the page using
 * those keys but adds no translations, and the i18n lint rule only flags UNUSED
 * keys (not missing ones), and the page references them via a constant the eslint
 * i18n-keys plugin can't trace — so without this the page shows raw keys like
 * "features.bookmark.title" at runtime (found live). Deterministic default copy
 * (the entity name + a generic empty state); the model/user can refine wording.
 * Pure `addFeatureI18nKeys` is unit-tested; this walks the locale dirs.
 */
export async function wireI18nKeys(cwd: string, name: string): Promise<void> {
  const localesDir = join(cwd, "apps/ui/src/lib/i18n/locales");

  if (!existsSync(localesDir)) {
    return;
  }

  const langs = await readdir(localesDir);

  for (const lang of langs) {
    const file = join(localesDir, lang, "common.json");

    if (!existsSync(file)) {
      continue;
    }

    const src = await readFile(file, "utf-8");
    const out = addFeatureI18nKeys(src, name);

    if (out !== src) {
      await writeFile(file, out, "utf-8");
    }
  }
}

/**
 * Add `features.<lower>.{title,empty}` to a locale `common.json` string with
 * default copy. Idempotent (returns the source unchanged when the key already
 * exists) and defensive (returns it unchanged when the JSON can't be parsed or
 * isn't an object). Pure — unit-tested.
 */
export function addFeatureI18nKeys(jsonSrc: string, name: string): string {
  const camel = toCamelCase(name);
  const lower = camel.toLowerCase();
  const Title = camel.charAt(0).toUpperCase() + camel.slice(1);

  let data: unknown;

  try {
    data = JSON.parse(jsonSrc);
  } catch {
    return jsonSrc;
  }

  if (!isRecord(data)) {
    return jsonSrc;
  }

  const features = isRecord(data.features) ? { ...data.features } : {};

  // Idempotent: leave existing copy (possibly human-refined) untouched.
  if (isRecord(features[lower])) {
    return jsonSrc;
  }

  features[lower] = { title: Title, empty: "Nothing here yet." };

  return `${JSON.stringify({ ...data, features }, null, 2)}\n`;
}
