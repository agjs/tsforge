import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ISlice } from "../planning/plan-types";
import type { IPhaserViewIntent } from "./plan-extension";
import { sceneFolder, toCamelCase, toKebabCase } from "./case";
import type { Exec } from "./exec";

const GAME_CONFIG = "src/app/config/gameConfig.ts";
const COMPOSE_RUNTIME = "src/app/composition/composeRuntime.ts";
const PORTS = "src/shared/types/ports.ts";
const PORTS_INDEX = "src/shared/types/index.ts";
const SCHEMAS_INDEX = "src/content/schemas/index.ts";

function sceneSetupRel(scene: string): string {
  const folder = sceneFolder(scene);

  return `src/runtime/phaser/scenes/${folder}/${folder}.setup.ts`;
}

function insertAfterLastImport(src: string, importLine: string): string {
  if (src.includes(importLine.trimEnd())) {
    return src;
  }

  const lastImportIndex = src.lastIndexOf("import ");

  if (lastImportIndex === -1) {
    throw new Error("No import statement found");
  }

  const importEndIndex = src.indexOf("\n", lastImportIndex);

  if (importEndIndex === -1) {
    throw new Error("No newline after import found");
  }

  return (
    src.slice(0, importEndIndex + 1) +
    importLine +
    src.slice(importEndIndex + 1)
  );
}

export function wireGameConfigSource(src: string, className: string): string {
  const importLine = `import { ${className} } from '../../runtime/phaser/scenes/${className}/index.js';\n`;

  if (!src.includes("scene:")) {
    throw new Error("wire: gameConfig.ts has no scene: array");
  }

  let out = src;

  if (!src.includes(importLine.trimEnd())) {
    out = insertAfterLastImport(out, importLine);
  }

  const sceneIdx2 = out.indexOf("scene:");
  const close2 = out.indexOf("]", sceneIdx2);

  if (close2 === -1) {
    throw new Error("wire: gameConfig.ts scene array is unclosed");
  }

  const body = out.slice(sceneIdx2, close2);

  if (new RegExp(`\\b${className}\\b`, "u").test(body)) {
    return out;
  }

  return `${out.slice(0, close2)}, ${className}${out.slice(close2)}`;
}

export function wireFeatureSetupSource(
  src: string,
  pascal: string,
  camel: string
): string {
  const importLine = `import { create${pascal}Feature } from '@features/${camel}';\n`;
  const construct = `const ${camel} = create${pascal}Feature`;

  let out = src;

  if (!out.includes(importLine.trimEnd())) {
    out = insertAfterLastImport(out, importLine);
  }

  if (!out.includes(construct)) {
    const insertAt = out.search(/\n\s*return \{/u);

    if (insertAt === -1) {
      throw new Error("wire: setup file has no feature-construct anchor");
    }

    const line = `  const ${camel} = create${pascal}Feature({ events });\n`;

    out = `${out.slice(0, insertAt)}\n${line}${out.slice(insertAt)}`;
  }

  const disposeIdx = out.search(/dispose\s*\(\s*\)\s*\{/u);

  if (disposeIdx === -1) {
    throw new Error("wire: setup file has no dispose() {");
  }

  const brace = out.indexOf("{", disposeIdx);
  const disposeCall = `${camel}.dispose();`;

  if (out.includes(disposeCall)) {
    return out;
  }

  return `${out.slice(0, brace + 1)}\n      ${disposeCall}${out.slice(brace + 1)}`;
}

export function wireSchemaIndexSource(
  src: string,
  pascal: string,
  kebab: string
): string {
  const line = `export { ${pascal}Schema } from './${kebab}.schema.js';\nexport type { ${pascal} } from './${kebab}.schema.js';\n`;

  if (src.includes(`${pascal}Schema`)) {
    return src;
  }

  return src.endsWith("\n") ? `${src}${line}` : `${src}\n${line}`;
}

export function wirePortsSource(src: string, pascal: string): string {
  const iface = `I${pascal}Port`;

  if (src.includes(`export interface ${iface}`)) {
    return src;
  }

  const stub = `\nexport interface ${iface} {\n  // filled by the slice\n}\n`;

  return src.endsWith("\n") ? `${src}${stub}` : `${src}\n${stub}`;
}

export function wirePortsIndexSource(src: string, pascal: string): string {
  const iface = `I${pascal}Port`;

  if (src.includes(iface)) {
    return src;
  }

  return src.replace(
    /from '\.\/ports\.js';/u,
    `from './ports.js';\nexport type { ${iface} } from './ports.js';`
  );
}

async function rewrite(
  cwd: string,
  rel: string,
  transform: (src: string) => string,
  required: boolean
): Promise<string | null> {
  const full = join(cwd, rel);

  if (!existsSync(full)) {
    if (required) {
      throw new Error(`wire: missing ${rel}`);
    }

    return null;
  }

  const prev = await readFile(full, "utf8");
  const next = transform(prev);

  if (next !== prev) {
    await writeFile(full, next, "utf8");
  }

  return rel;
}

export interface IWireSliceResult {
  readonly paths: readonly string[];
}

async function wireScene(cwd: string, scene: string): Promise<string[]> {
  const rel = await rewrite(
    cwd,
    GAME_CONFIG,
    (src) => wireGameConfigSource(src, sceneFolder(scene)),
    true
  );

  return rel === null ? [] : [rel];
}

async function wireFeature(
  cwd: string,
  slice: ISlice<IPhaserViewIntent>,
  pascal: string,
  camel: string
): Promise<string[]> {
  const rel = await rewrite(
    cwd,
    sceneSetupRel(slice.ui.scene),
    (src) => wireFeatureSetupSource(src, pascal, camel),
    true
  );

  return rel === null ? [] : [rel];
}

async function wireContent(
  cwd: string,
  pascal: string,
  kebab: string,
  exec: Exec
): Promise<string[]> {
  const touched: string[] = [];
  const rel = await rewrite(
    cwd,
    SCHEMAS_INDEX,
    (src) => wireSchemaIndexSource(src, pascal, kebab),
    false
  );

  if (rel !== null) {
    touched.push(rel);
  }

  const catalog = await exec(["bun", "run", "catalog"], { cwd });

  if (catalog.code !== 0) {
    throw new Error(catalog.stderr);
  }

  touched.push("docs/ai/catalog.md");

  return touched;
}

async function wirePort(cwd: string, pascal: string): Promise<string[]> {
  const touched: string[] = [];
  const ports = await rewrite(
    cwd,
    PORTS,
    (src) => wirePortsSource(src, pascal),
    true
  );

  if (ports !== null) {
    touched.push(ports);
  }

  const index = await rewrite(
    cwd,
    PORTS_INDEX,
    (src) => wirePortsIndexSource(src, pascal),
    false
  );

  if (index !== null) {
    touched.push(index);
  }

  const compose = join(cwd, COMPOSE_RUNTIME);

  if (!existsSync(compose)) {
    throw new Error(`wire: missing ${COMPOSE_RUNTIME}`);
  }

  touched.push(COMPOSE_RUNTIME);

  return touched;
}

/**
 * Idempotent inserts the generators leave as a human TODO. Fails loud if a
 * required wire target is missing.
 */
export async function wireSlice(
  cwd: string,
  slice: ISlice<IPhaserViewIntent>,
  exec: Exec
): Promise<IWireSliceResult> {
  const pascal = slice.entity.id;
  const camel = toCamelCase(pascal);
  const kebab = toKebabCase(pascal);

  switch (slice.ui.kind) {
    case "scene":
      return { paths: await wireScene(cwd, slice.ui.scene) };
    case "feature":
      return { paths: await wireFeature(cwd, slice, pascal, camel) };
    case "content":
      return { paths: await wireContent(cwd, pascal, kebab, exec) };
    case "port":
      return { paths: await wirePort(cwd, pascal) };
    case "module":
      return { paths: [] };
  }
}
