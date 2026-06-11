/**
 * Route scaffolding — the `scaffold_routes` tool's materializer. The MODEL
 * declares which pages the app needs (entirely app-specific, from the user's
 * prompt); this turns each path into a mechanically-correct TanStack file-based
 * route STUB so the model never hand-writes `createFileRoute` boilerplate, never
 * mis-maps a `$param` filename, and — crucially — every route exists at once, so
 * the typed route union is complete and no `<Link to>` can forward-reference a
 * not-yet-created route. Same division as scaffold_ui: model picks WHAT, the
 * harness does HOW. Stubs render a placeholder; the model fills each component in.
 */

/** Normalize a declared path to a leading-slash, no-trailing-slash form. */
export function normalizeRoutePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");

  if (trimmed.length === 0 || trimmed === "/") {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Map a route path to its TanStack file-based filename:
 *  "/" → src/routes/index.tsx, "/accounts/$accountId" →
 *  src/routes/accounts.$accountId.tsx, "/settings/profile" →
 *  src/routes/settings.profile.tsx (segments joined with "."). */
export function routeFileName(path: string): string {
  const body = normalizeRoutePath(path).replace(/^\//, "");
  const stem = body.length === 0 ? "index" : body.split("/").join(".");

  return `src/routes/${stem}.tsx`;
}

/** A valid, unique-ish PascalCase component name for a path's stub. "/" →
 *  IndexPage, "/accounts/$accountId" → AccountsAccountIdPage. */
export function routeComponentName(path: string): string {
  const body = normalizeRoutePath(path).replace(/^\//, "");

  if (body.length === 0) {
    return "IndexPage";
  }

  const pascal = body
    .split("/")
    .map((seg) =>
      seg
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .split(" ")
        .filter((w) => w.length > 0)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("")
    )
    .join("");

  return `${pascal}Page`;
}

/** A minimal, gate-passing route stub — same idiom as the scaffolded index route
 *  (no comments, prettier-clean), rendering the path as a placeholder. */
export function routeStub(path: string): string {
  const route = normalizeRoutePath(path);
  const name = routeComponentName(route);

  // The placeholder carries `data-tsforge-stub` — a sentinel the gate greps for so
  // an UNFILLED stub fails the build (coverage "file exists" + the render smoke
  // "not blank" both miss an empty route). The model must REPLACE this component
  // with the real page; doing so removes the marker.
  return (
    `import { createFileRoute } from "@tanstack/react-router";\n\n` +
    `export const Route = createFileRoute("${route}")({\n` +
    `  component: ${name},\n` +
    `});\n\n` +
    `function ${name}() {\n` +
    `  return (\n` +
    `    <div data-tsforge-stub className="p-8">\n` +
    `      TODO: build the ${route} page\n` +
    `    </div>\n` +
    `  );\n` +
    `}\n`
  );
}

/** Materialize stub files for every declared path → { relPath: content }.
 *  Deduped by filename so two spellings of one path don't clobber. */
export function materializeRoutes(
  paths: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const path of paths) {
    out[routeFileName(path)] = routeStub(path);
  }

  return out;
}

/** The URL path a route FILE serves, for crawling: "index.tsx" → "/",
 *  "accounts.create.tsx" → "/accounts/create", "settings.profile.tsx" →
 *  "/settings/profile". Returns null for things we can't visit statically:
 *  the root layout (__root) and any DYNAMIC route (a `$param` segment — we have
 *  no real id to fill). */
export function routePathFromFile(filename: string): string | null {
  const stem = filename.replace(/\.tsx$/, "");

  if (stem === "__root") {
    return null;
  }

  const segments = stem.split(".");

  if (segments.some((s) => s.startsWith("$"))) {
    return null;
  }

  if (stem === "index") {
    return "/";
  }

  return `/${segments.join("/")}`;
}

/** The set of statically-crawlable URL paths from a list of route filenames
 *  (skips the root layout + dynamic `$param` routes), deduped. */
export function crawlableRoutePaths(routeFiles: readonly string[]): string[] {
  const paths = new Set<string>();

  for (const file of routeFiles) {
    const path = routePathFromFile(file);

    if (path !== null) {
      paths.add(path);
    }
  }

  return [...paths];
}

/** Validate + normalize the tool's `routes` arg: a non-empty array of path
 *  strings. Returns [] (caller rejects) when the shape is wrong. */
export function asRoutePaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const paths = value.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0
  );

  return paths.map(normalizeRoutePath);
}
