import { test, expect } from "bun:test";
import {
  isNewer,
  isCacheStale,
  updateChecksEnabled,
  fetchLatest,
  getUpdateNotice,
  refreshIfStale,
  currentVersion,
  type IUpdateDeps,
  type IUpdateCache,
} from "../src/update-check";

const deps = (over: Partial<IUpdateDeps>): IUpdateDeps => ({
  fetchFn: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ version: "9.9.9" }),
  }),
  now: () => 1_000_000,
  readCache: async () => null,
  writeCache: async () => undefined,
  env: {},
  isTTY: true,
  ...over,
});

test("isNewer compares semantic versions numerically, not as strings", () => {
  expect(isNewer("0.9.0", "0.8.0")).toBe(true);
  expect(isNewer("0.8.0", "0.8.0")).toBe(false);
  expect(isNewer("0.8.0", "0.9.0")).toBe(false);
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  expect(isNewer("0.8.1", "0.8.0")).toBe(true);
});

test("isNewer ignores a leading v and a prerelease suffix", () => {
  expect(isNewer("v0.9.0", "0.8.0")).toBe(true);
  expect(isNewer("0.9.0-beta.1", "0.9.0")).toBe(false);
});

test("updateChecksEnabled is true only for an interactive, unflagged env", () => {
  expect(updateChecksEnabled({}, true)).toBe(true);
});

test("updateChecksEnabled is false only in CI, under NO_UPDATE_NOTIFIER, or non-TTY", () => {
  expect(updateChecksEnabled({ CI: "true" }, true)).toBe(false);
  expect(updateChecksEnabled({ NO_UPDATE_NOTIFIER: "1" }, true)).toBe(false);
  expect(updateChecksEnabled({}, false)).toBe(false);
});

test("isCacheStale is true for a missing or old cache, false when fresh", () => {
  const now = 100 * 24 * 60 * 60 * 1000;

  expect(isCacheStale(null, now)).toBe(true);
  expect(
    isCacheStale({ checkedAt: now - 25 * 60 * 60 * 1000, latest: "1.0.0" }, now)
  ).toBe(true);
  expect(
    isCacheStale({ checkedAt: now - 60 * 1000, latest: "1.0.0" }, now)
  ).toBe(false);
});

test("fetchLatest extracts the version from the registry response", async () => {
  const v = await fetchLatest(
    deps({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: "1.2.3" }),
      }),
    })
  );

  expect(v).toBe("1.2.3");
});

test("fetchLatest returns null on non-OK, malformed, or thrown response", async () => {
  expect(
    await fetchLatest(
      deps({
        fetchFn: async () => ({
          ok: false,
          status: 503,
          json: async () => ({}),
        }),
      })
    )
  ).toBeNull();
  expect(
    await fetchLatest(
      deps({
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ nope: 1 }),
        }),
      })
    )
  ).toBeNull();
  expect(
    await fetchLatest(
      deps({
        fetchFn: async () => {
          throw new Error("network down");
        },
      })
    )
  ).toBeNull();
});

test("getUpdateNotice returns a notice when the cached latest is newer", async () => {
  const n = await getUpdateNotice(
    "0.8.0",
    deps({ readCache: async () => ({ checkedAt: 1, latest: "0.9.0" }) })
  );

  expect(n).not.toBeNull();
  expect(n).toContain("0.9.0");
  expect(n?.toLowerCase()).toContain("available");
});

test("getUpdateNotice returns null when up to date or there is no cache", async () => {
  expect(
    await getUpdateNotice(
      "0.9.0",
      deps({ readCache: async () => ({ checkedAt: 1, latest: "0.9.0" }) })
    )
  ).toBeNull();
  expect(
    await getUpdateNotice("0.8.0", deps({ readCache: async () => null }))
  ).toBeNull();
});

test("getUpdateNotice returns null when gating disallows, even if newer", async () => {
  const n = await getUpdateNotice(
    "0.8.0",
    deps({
      readCache: async () => ({ checkedAt: 1, latest: "0.9.0" }),
      env: { CI: "1" },
    })
  );

  expect(n).toBeNull();
});

test("refreshIfStale fetches and writes the cache when stale", async () => {
  const cap: { value: IUpdateCache | null } = { value: null };

  await refreshIfStale(
    deps({
      readCache: async () => null,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ version: "2.0.0" }),
      }),
      now: () => 555,
      writeCache: async (d) => {
        cap.value = d;
      },
    })
  );

  expect(cap.value).toEqual({ checkedAt: 555, latest: "2.0.0" });
});

test("refreshIfStale does nothing when the cache is fresh", async () => {
  let wrote = false;

  await refreshIfStale(
    deps({
      readCache: async () => ({ checkedAt: 1_000_000, latest: "9.9.9" }),
      now: () => 1_000_000,
      writeCache: async () => {
        wrote = true;
      },
    })
  );

  expect(wrote).toBe(false);
});

test("refreshIfStale does nothing when the update check is disabled (CI)", async () => {
  let wrote = false;

  await refreshIfStale(
    deps({
      env: { CI: "1" },
      writeCache: async () => {
        wrote = true;
      },
    })
  );

  expect(wrote).toBe(false);
});

test("currentVersion reads the package's own x.y.z version", () => {
  expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+/);
});
