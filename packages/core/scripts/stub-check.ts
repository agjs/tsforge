#!/usr/bin/env bun
// Gate step: fail if any route is STILL an unfilled scaffold_routes stub. The
// scaffold lays down placeholder route files (marked `data-tsforge-stub`); the
// model must REPLACE each with the real page. An unfilled stub renders an empty
// placeholder — which the coverage gate (file exists) and the render smoke (root
// not blank) both miss — so without this an app of empty routes goes green.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MARKER = "data-tsforge-stub";
const dir = process.argv[2] ?? ".";
const routesDir = join(dir, "src", "routes");

let files: string[];

try {
  files = (await readdir(routesDir)).filter((f) => f.endsWith(".tsx"));
} catch {
  // No routes dir (non-web build) → nothing to enforce.
  process.exit(0);
}

const stubs: string[] = [];

for (const file of files) {
  const content = await readFile(join(routesDir, file), "utf8");

  if (content.includes(MARKER)) {
    stubs.push(file);
  }
}

if (stubs.length > 0) {
  process.stdout.write(
    `stub-check: ${String(stubs.length)} route(s) are still empty scaffold STUBS — ` +
      `replace each placeholder component with the REAL page (its list/detail/form, ` +
      `using the SDK + your components). The app is NOT done while these render a ` +
      `placeholder. Unfilled: ${stubs.join(", ")}\n`
  );
  process.exit(1);
}

process.stdout.write("stub-check: no unfilled route stubs\n");
process.exit(0);
