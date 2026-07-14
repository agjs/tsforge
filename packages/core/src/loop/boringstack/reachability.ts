import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { toCamelCase } from "./case";
import { isRecord } from "../../lib/guards";

/**
 * The inputs a reachability check reads — passed in as strings so the check itself
 * is PURE and unit-testable without the filesystem. `localeJsons` is every locale's
 * `common.json` content (empty when the app has no i18n).
 */
export interface IReachabilityInputs {
  /** SPA router source, or null when the app has no such file (aspect skipped). */
  readonly uiRoutes: string | null;
  /** API route-table source, or null when absent (aspect skipped). */
  readonly apiRoutes: string | null;
  /** Every locale's `common.json` content (empty when the app has no i18n). */
  readonly localeJsons: readonly string[];
}

export interface IReachabilityResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Verify a built feature is actually REACHABLE + USABLE, not merely compiling. The
 * strict gate (typecheck/lint/test) proves the code is well-formed; it does NOT
 * prove a user can get to the feature or that it renders real text. Three gaps hit
 * live — all gate-green — motivate this: (1) the UI page had no router entry
 * (unreachable), (2) the page rendered raw i18n keys (`features.x.title`), (3) the
 * API resource wasn't registered. This is a cheap STATIC check (no browser, no
 * booted stack) that closes exactly that class: fail the feature unless its route,
 * its i18n keys, and its API registration are all present. Pure — unit-tested.
 */
export function checkFeatureReachable(
  name: string,
  inputs: IReachabilityInputs
): IReachabilityResult {
  const camel = toCamelCase(name);
  const lower = camel.toLowerCase();
  const Name = camel.charAt(0).toUpperCase() + camel.slice(1);
  const problems: string[] = [];

  // 1. UI route: the SPA router must import + route the feature's page, else the
  //    page is built but unreachable (no URL/nav). Skipped when the app has no
  //    router file (null) — only a PRESENT router that omits the route is a defect.
  if (
    inputs.uiRoutes !== null &&
    !inputs.uiRoutes.includes(`features/${camel}/components/${Name}Page`)
  ) {
    problems.push(
      `UI route missing: ${Name}Page is not registered in the SPA router ` +
        `(app/router/routes.tsx) — the page would be unreachable.`
    );
  }

  // 2. API registration: the resource must be mounted in the API route table.
  if (
    inputs.apiRoutes !== null &&
    !inputs.apiRoutes.includes(`${camel}Routes`)
  ) {
    problems.push(
      `API route missing: ${camel}Routes is not registered in ` +
        `config/routes/routes.ts — the endpoints would be unreachable.`
    );
  }

  // 3. i18n keys: the generated page renders `features.<lower>.title`/`.empty`; if a
  //    locale lacks them the page shows the raw key string to the user.
  for (const [index, jsonSrc] of inputs.localeJsons.entries()) {
    if (!localeHasFeatureKeys(jsonSrc, lower)) {
      problems.push(
        `i18n keys missing for "${lower}" in locale #${String(index + 1)} — ` +
          `the page would render raw keys like "features.${lower}.title".`
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/** True when a locale JSON string has non-empty `features.<lower>.title` + `.empty`. */
function localeHasFeatureKeys(jsonSrc: string, lower: string): boolean {
  let data: unknown;

  try {
    data = JSON.parse(jsonSrc);
  } catch {
    return false;
  }

  if (!isRecord(data) || !isRecord(data.features)) {
    return false;
  }

  const feature = data.features[lower];

  if (!isRecord(feature)) {
    return false;
  }

  return (
    typeof feature.title === "string" &&
    feature.title.length > 0 &&
    typeof feature.empty === "string" &&
    feature.empty.length > 0
  );
}

/**
 * Read the reachability inputs for a feature from a boringstack clone and run the
 * static check. Missing files degrade gracefully (empty string / no locales) so a
 * boringstack variant with a different layout doesn't hard-fail the build — the
 * check simply reports what it can see.
 */
export async function verifyFeatureReachable(
  cwd: string,
  name: string
): Promise<IReachabilityResult> {
  const uiRoutesPath = join(cwd, "apps/ui/src/app/router/routes.tsx");
  const apiRoutesPath = join(cwd, "apps/api/src/config/routes/routes.ts");
  const localesDir = join(cwd, "apps/ui/src/lib/i18n/locales");

  const uiRoutes = await readIfExists(uiRoutesPath);
  const apiRoutes = await readIfExists(apiRoutesPath);
  const localeJsons = await readLocaleJsons(localesDir);

  return checkFeatureReachable(name, { uiRoutes, apiRoutes, localeJsons });
}

async function readIfExists(path: string): Promise<string | null> {
  return existsSync(path) ? await readFile(path, "utf-8") : null;
}

async function readLocaleJsons(localesDir: string): Promise<string[]> {
  if (!existsSync(localesDir)) {
    return [];
  }

  const langs = await readdir(localesDir);
  const out: string[] = [];

  for (const lang of langs) {
    const file = join(localesDir, lang, "common.json");

    if (existsSync(file)) {
      out.push(await readFile(file, "utf-8"));
    }
  }

  return out;
}
