#!/usr/bin/env bun
// Gate step (catalog builds): fail unless every declared entity has real UI — a
// feature folder with a component, not just a `.types.ts`. Wired into the web gate
// by headless-build so an app can't green with half its entities unbuilt (a run
// greened with 4 of 8 entities as types-only). Usage:
//   bun coverage-check.ts <buildDir> "<Entity1>" "<Entity2>" ...
import { uncoveredEntities } from "../src/web-coverage";

const [, , dir, ...entities] = process.argv;

if (dir === undefined || entities.length === 0) {
  // No entity list → nothing to enforce (ad-hoc build). Pass.
  process.exit(0);
}

const missing = await uncoveredEntities(dir, entities);

if (missing.length > 0) {
  const noun = missing.length === 1 ? "entity has" : "entities have";

  process.stdout.write(
    `coverage: ${String(missing.length)} declared ${noun} NO UI (types only) — ` +
      `build each one's list + create + detail routes and wire a reachable "New" ` +
      `button; the app is NOT done until every entity is reachable. Missing: ` +
      `${missing.join(", ")}\n`
  );
  process.exit(1);
}

process.stdout.write(
  `coverage: all ${String(entities.length)} declared entities have UI\n`
);
process.exit(0);
