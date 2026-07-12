import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { toCamelCase } from "./case";

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
