import { test, expect, describe } from "bun:test";
import {
  wireRoutesFile,
  wireAppFile,
  wireSwaggerFile,
  wireTestHelperFile,
  wireUiRouteFile,
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
