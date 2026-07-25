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

  test("a substring-only API match is NOT accepted (no false green off a sibling slice)", () => {
    // `count`'s own `countRoutes` is absent, but a prior slice registered
    // `accountRoutes` — which CONTAINS "countRoutes". A bare `.includes` would wrongly
    // pass `count` as reachable; the whole-identifier check must still flag it.
    const r = checkFeatureReachable("Count", {
      uiRoutes:
        'const CountPage = lazy(() => import("@/features/count/components/CountPage/CountPage"));',
      apiRoutes: "export const routes = {\n  account: accountRoutes,\n};",
      localeJsons: [
        JSON.stringify({
          features: { count: { title: "Counts", empty: "None." } },
        }),
      ],
    });

    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/API route missing/u);
  });

  test("a whole-identifier API match is accepted even next to a superstring sibling", () => {
    // Both `count` and `account` are registered: `count` must be seen as reachable
    // (its own whole-word `countRoutes` is present), not masked by `accountRoutes`.
    const r = checkFeatureReachable("Count", {
      uiRoutes:
        'const CountPage = lazy(() => import("@/features/count/components/CountPage/CountPage"));',
      apiRoutes:
        "export const routes = {\n  account: accountRoutes,\n  count: countRoutes,\n};",
      localeJsons: [
        JSON.stringify({
          features: { count: { title: "Counts", empty: "None." } },
        }),
      ],
    });

    expect(r.ok).toBe(true);
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

  test("a CUSTOMIZED/nested feature namespace passes (no false-fail on real content)", () => {
    // The bshands12 wall: the model restructured its i18n away from the default
    // `title`/`empty` into nested keys. Exact-key resolution is enforced by the
    // `static-translation-key-exists` lint rule; reachability only needs the feature
    // namespace to be populated — demanding the defaults false-failed for ~30 cycles.
    const r = checkFeatureReachable("Issue", {
      uiRoutes:
        'const IssuePage = lazy(() => import("@/features/issue/components/IssuePage/IssuePage"));',
      apiRoutes: "issue: issueRoutes,",
      localeJsons: [
        JSON.stringify({
          features: {
            issue: { list: { title: "Issues", empty: "No issues yet." } },
          },
        }),
      ],
    });

    expect(r.ok).toBe(true);
  });

  test("an EMPTY feature namespace is still flagged (page would render raw keys)", () => {
    const r = checkFeatureReachable("Bookmark", {
      ...wiredInputs(),
      localeJsons: [JSON.stringify({ features: { bookmark: {} } })],
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
