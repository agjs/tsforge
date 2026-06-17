import { test, expect } from "bun:test";
import { fetchLatest, type IUpdateDeps } from "../src/update-check";

// Live registry test is OPT-IN (TSFORGE_UPDATE_LIVE_TESTS=1): it hits the real
// npm registry, so it's non-deterministic and out of the default suite. The
// logic is covered deterministically (mocked fetch) in update-check.test.ts;
// this proves the real registry request + parse works end to end.
const enabled = process.env.TSFORGE_UPDATE_LIVE_TESTS === "1";
const liveTest = enabled ? test : test.skip;

const liveDeps = (): IUpdateDeps => ({
  fetchFn: (url) => fetch(url),
  now: () => 0,
  readCache: async () => null,
  writeCache: async () => undefined,
  env: {},
  isTTY: true,
});

liveTest(
  "fetchLatest returns a real published version from the npm registry",
  async () => {
    const v = await fetchLatest(liveDeps());

    expect(v).not.toBeNull();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  },
  30_000
);
