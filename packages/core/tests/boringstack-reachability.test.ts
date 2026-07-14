import { test, expect, describe } from "bun:test";
import {
  checkFeatureReachable,
  type IReachabilityInputs,
} from "../src/loop/boringstack/reachability";

/** A fully-wired feature: route present, API registered, i18n keys present. */
function wiredInputs(): IReachabilityInputs {
  return {
    uiRoutes:
      'const BookmarkPage = lazy(() => import("@/features/bookmark/components/BookmarkPage/BookmarkPage"));',
    apiRoutes: "export const routes = {\n  bookmark: bookmarkRoutes,\n};",
    localeJsons: [
      JSON.stringify({
        features: { bookmark: { title: "Bookmarks", empty: "None yet." } },
      }),
    ],
  };
}

describe("checkFeatureReachable", () => {
  test("ok when route, API, and i18n keys are all present", () => {
    const r = checkFeatureReachable("Bookmark", wiredInputs());

    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  test("flags a missing UI route (unreachable page)", () => {
    const r = checkFeatureReachable("Bookmark", {
      ...wiredInputs(),
      uiRoutes: "const DashboardPage = lazy(() => import('...'));",
    });

    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/UI route missing/u);
  });

  test("flags an unregistered API resource", () => {
    const r = checkFeatureReachable("Bookmark", {
      ...wiredInputs(),
      apiRoutes: "export const routes = {\n  health: healthRoutes,\n};",
    });

    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/API route missing/u);
  });

  test("flags missing i18n keys (page would show raw keys)", () => {
    const r = checkFeatureReachable("Bookmark", {
      ...wiredInputs(),
      localeJsons: [JSON.stringify({ features: {} })],
    });

    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/i18n keys missing/u);
  });

  test("flags i18n present in one locale but missing in another", () => {
    const r = checkFeatureReachable("Bookmark", {
      ...wiredInputs(),
      localeJsons: [
        JSON.stringify({
          features: { bookmark: { title: "Bookmarks", empty: "None." } },
        }),
        JSON.stringify({ features: {} }), // e.g. `de` not seeded
      ],
    });

    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/i18n keys missing.*#2/u);
  });

  test("empty title/empty strings do NOT count as present", () => {
    const r = checkFeatureReachable("Bookmark", {
      ...wiredInputs(),
      localeJsons: [
        JSON.stringify({ features: { bookmark: { title: "", empty: "" } } }),
      ],
    });

    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/i18n keys missing/u);
  });

  test("an app with no locales at all skips the i18n check (no false failure)", () => {
    const r = checkFeatureReachable("Bookmark", {
      ...wiredInputs(),
      localeJsons: [],
    });

    expect(r.ok).toBe(true);
  });

  test("a missing router/API file (null) is skipped, not flagged — only a PRESENT-but-unwired file is a defect", () => {
    const r = checkFeatureReachable("Bookmark", {
      uiRoutes: null,
      apiRoutes: null,
      localeJsons: [],
    });

    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });
});
