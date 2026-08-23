import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ISlice } from "../planning/plan-types";
import type { IPhaserViewIntent } from "./plan-extension";
import { sceneFolder, toCamelCase, toKebabCase } from "./case";
import type { Exec } from "./exec";

function makeErrorWithStderr(stderr: string): Error {
  return new Error(stderr);
}

async function execOrThrow(
  exec: Exec,
  argv: readonly string[],
  cwd: string
): Promise<void> {
  const result = await exec(argv, { cwd });

  if (result.code !== 0) {
    throw makeErrorWithStderr(result.stderr);
  }
}

/** Paths the template generator owns for this slice (cwd-relative). */
export function sliceOwnedPaths(slice: ISlice<IPhaserViewIntent>): string[] {
  const pascal = slice.entity.id;
  const camel = toCamelCase(pascal);
  const kebab = toKebabCase(pascal);
  const folder = sceneFolder(slice.ui.scene);

  switch (slice.ui.kind) {
    case "feature":
      return [
        `src/features/${camel}/${pascal}Feature.ts`,
        `src/features/${camel}/${pascal}Feature.test.ts`,
        `src/features/${camel}/index.ts`,
      ];
    case "scene":
      return [
        `src/runtime/phaser/scenes/${folder}/${folder}.ts`,
        `src/runtime/phaser/scenes/${folder}/${folder}.setup.ts`,
        `src/runtime/phaser/scenes/${folder}/${folder}.constants.ts`,
        `src/runtime/phaser/scenes/${folder}/index.ts`,
      ];
    case "module":
      return [
        `src/domain/${camel}/${pascal}.types.ts`,
        `src/domain/${camel}/${pascal}.model.ts`,
        `src/domain/${camel}/${pascal}.behavior.ts`,
        `src/domain/${camel}/${pascal}.constants.ts`,
        `src/domain/${camel}/${pascal}.system.ts`,
        `src/domain/${camel}/${pascal}.contracts.ts`,
        `src/domain/${camel}/${pascal}.test.ts`,
        `src/domain/${camel}/index.ts`,
      ];
    case "content":
      return [
        `src/content/schemas/${kebab}.schema.ts`,
        `src/content/definitions/${kebab}s/index.ts`,
      ];
    case "port":
      return [`src/shared/testing/fake${pascal}.port.ts`];
  }
}

function skipPath(cwd: string, slice: ISlice<IPhaserViewIntent>): string {
  const pascal = slice.entity.id;
  const camel = toCamelCase(pascal);
  const kebab = toKebabCase(pascal);
  const folder = sceneFolder(slice.ui.scene);

  switch (slice.ui.kind) {
    case "feature":
      return join(cwd, "src/features", camel);
    case "scene":
      return join(cwd, "src/runtime/phaser/scenes", folder);
    case "module":
      return join(cwd, "src/domain", camel);
    case "content":
      return join(cwd, "src/content/schemas", `${kebab}.schema.ts`);
    case "port":
      return join(cwd, "src/shared/testing", `fake${pascal}.port.ts`);
  }
}

function generateArgv(slice: ISlice<IPhaserViewIntent>): readonly string[] {
  const pascal = slice.entity.id;
  const folder = sceneFolder(slice.ui.scene);

  switch (slice.ui.kind) {
    case "feature":
      return ["bun", "run", "new:feature", "--", pascal];
    case "scene":
      return ["bun", "run", "new:scene", "--", folder];
    case "module":
      return ["bun", "run", "new:module", "--", pascal];
    case "content":
      return ["bun", "run", "new:content", "--", pascal];
    case "port":
      return ["bun", "run", "new:port", "--", pascal];
  }
}

export interface IGenerateSliceResult {
  readonly skipped: boolean;
  readonly argv: readonly string[] | null;
  readonly paths: readonly string[];
}

/**
 * Run the template `bun run new:*` for this slice. Idempotent: skip if the
 * generator's dir/file already exists so a retry does not clobber fills.
 */
export async function generateSlice(
  cwd: string,
  slice: ISlice<IPhaserViewIntent>,
  exec: Exec
): Promise<IGenerateSliceResult> {
  const paths = sliceOwnedPaths(slice);

  if (existsSync(skipPath(cwd, slice))) {
    return { skipped: true, argv: null, paths };
  }

  const argv = generateArgv(slice);

  await execOrThrow(exec, argv, cwd);

  return { skipped: false, argv, paths };
}
