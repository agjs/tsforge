import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function toCamelCase(pascalName: string): string {
  return pascalName.charAt(0).toLowerCase() + pascalName.slice(1);
}

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
}
