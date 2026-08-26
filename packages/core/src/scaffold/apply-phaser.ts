import { isRecord } from "../lib/guards";
import type { IScaffoldFs, IScaffoldRunner } from "./io";

/** Lowercase npm-safe name from a scaffold folder. */
export function phaserPackageName(folder: string): string {
  const n = folder
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-");

  return n.length > 0 ? n : "phaser-game";
}

/**
 * After cloning the Phaser template, stamp the dest folder into package.json
 * `name` and replace the starter HTML title. No compose/env — identity only.
 */
export async function applyPhaserIdentity(
  dest: string,
  projectName: string,
  fs: IScaffoldFs
): Promise<void> {
  const pkgPath = `${dest}/package.json`;

  if (await fs.exists(pkgPath)) {
    const raw: unknown = JSON.parse(await fs.readText(pkgPath));

    if (!isRecord(raw)) {
      throw new Error("scaffold: Phaser package.json is not an object");
    }

    await fs.writeText(
      pkgPath,
      `${JSON.stringify({ ...raw, name: phaserPackageName(projectName) }, null, 2)}\n`
    );
  }

  const htmlPath = `${dest}/index.html`;

  if (await fs.exists(htmlPath)) {
    const html = await fs.readText(htmlPath);
    const next = html.replace(
      /<title>Phaser TS Starter<\/title>/u,
      `<title>${projectName}</title>`
    );

    if (next !== html) {
      await fs.writeText(htmlPath, next);
    }
  }
}

/**
 * If the clone is missing `docs/ai/catalog.md`, run the template catalog script.
 * Never fails scaffold — a missing script or non-zero exit is ignored.
 */
export async function ensurePhaserCatalog(
  dest: string,
  fs: IScaffoldFs,
  run: IScaffoldRunner
): Promise<void> {
  if (await fs.exists(`${dest}/docs/ai/catalog.md`)) {
    return;
  }

  try {
    await run(dest, ["bun", "run", "catalog"]);
  } catch {
    return;
  }
}
