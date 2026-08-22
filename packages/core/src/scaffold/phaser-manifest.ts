import { readFileSync } from "node:fs";
import type { IScaffoldManifest } from "./scaffold.types";
import { parseManifest } from "./boringstack-manifest";

let cached: IScaffoldManifest | undefined;

/** tsforge-owned Phaser clone descriptor (repo + pin + gates). Not a fullstack
 *  env manifest — the Phaser template repo does not ship scaffold-manifest.json. */
export function loadPhaserTemplate(): IScaffoldManifest {
  cached ??= parseManifest(
    JSON.parse(
      readFileSync(new URL("./phaser-template.json", import.meta.url), "utf8")
    )
  );

  return cached;
}
