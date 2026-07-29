import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wireRoutesFile,
  wireAppFile,
  wireSwaggerFile,
  wireTestHelperFile,
  wireUiRouteFile,
  addFeatureI18nKeys,
  wireHomeRedirect,
  applyHomeRedirect,
} from "../src/loop/boringstack/wire-resource";

/** A minimal stand-in for boringstack's SPA router, carrying the anchors the
 *  injector keys off (the lazy-import block + the createBrowserRouter array with
 *  the ProtectedRoute/AppShell/Suspense/Fallback wrapper). */
const ROUTER_SRC = `import { type FC, Suspense, lazy } from "react";
import { createBrowserRouter } from "react-router-dom";
import { AppShell } from "@/components/core/AppShell";
import { ProtectedRoute } from "./ProtectedRoute";

const Fallback: FC = () => null;

const DashboardPage = lazy(() =>
  import("@/features/dashboard/components/DashboardPage").then((m) => ({
    default: m.DashboardPage
  }))
);

const router = createBrowserRouter([
  {
    path: "/dashboard",
    element: (
      <ProtectedRoute>
        <AppShell>
          <Suspense fallback={<Fallback />}>
            <DashboardPage />
          </Suspense>
        </AppShell>
      </ProtectedRoute>
    )
  }
]);
`;

describe("wireUiRouteFile", () => {
  test("adds a lazy import + an authenticated route for the feature page", () => {
    const out = wireUiRouteFile(ROUTER_SRC, "Bookmark");

    expect(out).toContain(
      'import("@/features/bookmark/components/BookmarkPage/BookmarkPage")'
    );
    expect(out).toContain("default: m.BookmarkPage");
    expect(out).toContain('path: "/bookmark"');
    expect(out).toContain("<BookmarkPage />");
    // Wraps in the same ProtectedRoute/AppShell as the other authed routes.
    expect(out).toContain("<ProtectedRoute>");
    // Did not disturb the existing route.
    expect(out).toContain('path: "/dashboard"');
    // The result still parses as TSX.
    expect(() =>
      new Bun.Transpiler({ loader: "tsx" }).transformSync(out)
    ).not.toThrow();
  });

  test("is idempotent — re-wiring the same feature is a no-op", () => {
    const once = wireUiRouteFile(ROUTER_SRC, "Bookmark");
    const twice = wireUiRouteFile(once, "Bookmark");

    expect(twice).toBe(once);
  });

  test("throws when the router anchor is missing", () => {
    expect(() => wireUiRouteFile("export const x = 1;\n", "Bookmark")).toThrow(
      /Anchor not found/u
    );
  });
});

describe("addFeatureI18nKeys", () => {
  test("adds features.<lower>.{title,empty} so the page renders text, not raw keys", () => {
    const src = JSON.stringify({ dashboard: { title: "Dashboard" } }, null, 2);
    const out = addFeatureI18nKeys(src, "Bookmark");
    const parsed: unknown = JSON.parse(out);

    expect(isRecordLike(parsed)).toBe(true);
    const features = getRecord(parsed, "features");
    const bookmark = getRecord(features, "bookmark");

    expect(bookmark.title).toBe("Bookmark");
    expect(typeof bookmark.empty).toBe("string");
    // Existing namespaces are preserved.
    expect(getRecord(parsed, "dashboard").title).toBe("Dashboard");
  });

  test("is idempotent — existing (possibly human-refined) copy is left alone", () => {
    const src = JSON.stringify(
      { features: { bookmark: { title: "My Links", empty: "None" } } },
      null,
      2
    );

    expect(addFeatureI18nKeys(src, "Bookmark")).toBe(src);
  });

  test("returns the source unchanged when it isn't parseable JSON", () => {
    expect(addFeatureI18nKeys("not json", "Bookmark")).toBe("not json");
  });
});

/** Minimal record helpers for asserting on parsed JSON without `as`. */
function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function getRecord(v: unknown, key: string): Record<string, unknown> {
  if (isRecordLike(v) && isRecordLike(v[key])) {
    return v[key];
  }

  throw new Error(`expected a record at "${key}"`);
}

describe("wireRoutesFile", () => {
  test("adds import + object entry", () => {
    const src = `import healthRoutes from "../../api/health/health.routes";\n\nexport const routes = {\n  health: healthRoutes,\n};\n`;
    const out = wireRoutesFile(src, "Invoice");

    expect(out).toContain(
      'import invoiceRoutes from "../../api/invoice/invoice.routes";'
    );
    expect(out).toContain("invoice: invoiceRoutes,");
    expect(out).toContain("health: healthRoutes,");
  });

  test("is idempotent — re-wiring an already-mounted route is a no-op (build13 remount safety)", () => {
    const src = `import healthRoutes from "../../api/health/health.routes";\n\nexport const routes = {\n  health: healthRoutes,\n};\n`;
    const once = wireRoutesFile(src, "Invoice");

    // wireResource now runs on EVERY attempt, so a second wire must NOT double-insert.
    expect(wireRoutesFile(once, "Invoice")).toBe(once);
  });

  test("self-heals a PARTIAL state: entry present but import reverted → adds the import (no dup entry)", () => {
    // import line removed, map entry left behind — the guard must restore the import only.
    const src = `import healthRoutes from "../../api/health/health.routes";\n\nexport const routes = {\n  health: healthRoutes,\n  invoice: invoiceRoutes,\n};\n`;
    const out = wireRoutesFile(src, "Invoice");

    expect(out).toContain(
      'import invoiceRoutes from "../../api/invoice/invoice.routes";'
    );
    expect(out.split("invoice: invoiceRoutes,").length - 1).toBe(1); // entry not duplicated
  });

  test("self-heals a PARTIAL state: import present but entry reverted → adds the entry (no dup import)", () => {
    const src = `import healthRoutes from "../../api/health/health.routes";\nimport invoiceRoutes from "../../api/invoice/invoice.routes";\n\nexport const routes = {\n  health: healthRoutes,\n};\n`;
    const out = wireRoutesFile(src, "Invoice");

    expect(out).toContain("invoice: invoiceRoutes,");
    expect(
      out.split('import invoiceRoutes from "../../api/invoice/invoice.routes";')
        .length - 1
    ).toBe(1); // import not duplicated
  });
});

describe("wireAppFile", () => {
  test("inserts the group mount", () => {
    const src = `  return (\n    app\n      .use(routes.health)\n  );\n`;

    const out = wireAppFile(src, "Invoice");

    expect(out).toContain(
      '.group("/api/v1/invoice", (group) => group.use(routes.invoice))'
    );
    expect(out).toContain(".use(routes.health)");
  });

  test("is idempotent — the group mount is inserted at most once", () => {
    const src = `  return (\n    app\n      .use(routes.health)\n  );\n`;
    const once = wireAppFile(src, "Invoice");

    expect(wireAppFile(once, "Invoice")).toBe(once);
  });
});

describe("wireSwaggerFile", () => {
  test("adds a tag", () => {
    const src = `    tags: [\n      { name: "Health", description: "probes" },\n    ],\n`;

    const out = wireSwaggerFile(src, "Invoice");

    expect(out).toContain(
      '{ name: "Invoice", description: "Invoice resource" }'
    );
    expect(out).toContain('{ name: "Health", description: "probes" }');
  });

  test("is idempotent — the swagger tag is added at most once", () => {
    const src = `    tags: [\n      { name: "Health", description: "probes" },\n    ],\n`;
    const once = wireSwaggerFile(src, "Invoice");

    expect(wireSwaggerFile(once, "Invoice")).toBe(once);
  });
});

describe("wireTestHelperFile", () => {
  const helper = `export { and, eq } from "drizzle-orm";
export {
  accounts,
  users,
} from "../../src/clients/postgres/schema";
export type { IUser } from "../../src/api/users/users.types";
`;

  test("adds the new table to the schema re-export block", () => {
    const out = wireTestHelperFile(helper, "Invoice");

    expect(out).toContain("  invoice,");
    // still inside the schema block (before its closing `from` line)
    const blockEnd = out.indexOf('} from "../../src/clients/postgres/schema";');

    expect(out.slice(0, blockEnd)).toContain("  invoice,");
    // existing exports untouched
    expect(out).toContain("  accounts,");
    expect(out).toContain("  users,");
  });

  test("is idempotent — a table already listed is not added twice", () => {
    const once = wireTestHelperFile(helper, "Invoice");
    const twice = wireTestHelperFile(once, "Invoice");

    expect(twice).toBe(once);
    expect(twice.match(/ {2}invoice,/g)).toHaveLength(1);
  });

  test("throws when the schema re-export anchor is missing", () => {
    expect(() =>
      wireTestHelperFile("export {} from 'elsewhere';", "X")
    ).toThrow("Anchor not found");
  });
});

describe("wireHomeRedirect", () => {
  test("repoints DEFAULT_REDIRECT_TO at the home feature's route", () => {
    const src = 'export const DEFAULT_REDIRECT_TO = "/dashboard";\n';

    expect(wireHomeRedirect(src, "/task")).toBe(
      'export const DEFAULT_REDIRECT_TO = "/task";\n'
    );
  });

  test("is idempotent + self-healing regardless of the current value", () => {
    const already = 'export const DEFAULT_REDIRECT_TO = "/task";';

    expect(wireHomeRedirect(already, "/task")).toBe(already);
    // A different current value is corrected, not appended.
    expect(
      wireHomeRedirect(
        'export const DEFAULT_REDIRECT_TO = "/project";',
        "/task"
      )
    ).toBe('export const DEFAULT_REDIRECT_TO = "/task";');
  });

  test("throws (never silently no-ops) if the anchor is missing", () => {
    // A silent no-op would leave the landing at /dashboard — the false-green this determinism fixes.
    expect(() => wireHomeRedirect("export const OTHER = 1;", "/task")).toThrow(
      "DEFAULT_REDIRECT_TO not found"
    );
  });
});

describe("applyHomeRedirect (fs wrapper)", () => {
  const CONSTS_REL =
    "apps/ui/src/features/auth/components/LoginPage/LoginPage.constants.ts";

  test("rewrites the scaffold LoginPage constants at the home route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsforge-redirect-"));

    try {
      await mkdir(join(dir, CONSTS_REL, ".."), { recursive: true });
      await writeFile(
        join(dir, CONSTS_REL),
        'export const DEFAULT_REDIRECT_TO = "/dashboard";\n',
        "utf-8"
      );

      await applyHomeRedirect(dir, "/task");

      expect(await readFile(join(dir, CONSTS_REL), "utf-8")).toBe(
        'export const DEFAULT_REDIRECT_TO = "/task";\n'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("THROWS (not a silent skip) when the login constants file is absent", async () => {
    // Silently skipping would leave the landing at /dashboard while the build goes green.
    const dir = await mkdtemp(join(tmpdir(), "tsforge-redirect-"));

    try {
      await expect(applyHomeRedirect(dir, "/task")).rejects.toThrow(
        "not found"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
