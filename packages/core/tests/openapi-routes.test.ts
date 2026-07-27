import { test, expect } from "bun:test";
import {
  expectedRoutePaths,
  checkRoutesServed,
  fetchServedPaths,
  type SpecFetcher,
} from "../src/loop/boringstack/openapi-routes";

test("expectedRoutePaths: collection root (trailing slash) + by-id", () => {
  expect(expectedRoutePaths("bookmark")).toEqual([
    "/api/v1/bookmark/",
    "/api/v1/bookmark/{id}",
  ]);
});

test("checkRoutesServed: both paths present → ok", () => {
  const r = checkRoutesServed(
    ["/api/v1/bookmark/", "/api/v1/bookmark/{id}", "/api/v1/other/"],
    "bookmark"
  );

  expect(r.ok).toBe(true);
  expect(r.missing).toEqual([]);
});

test("checkRoutesServed: by-id path missing → NOT ok, names it", () => {
  const r = checkRoutesServed(["/api/v1/bookmark/"], "bookmark");

  expect(r.ok).toBe(false);
  expect(r.missing).toEqual(["/api/v1/bookmark/{id}"]);
});

test("checkRoutesServed: a source-registered route that isn't served at all → both missing", () => {
  const r = checkRoutesServed(["/api/v1/other/", "/health"], "bookmark");

  expect(r.ok).toBe(false);
  expect(r.missing).toEqual(["/api/v1/bookmark/", "/api/v1/bookmark/{id}"]);
});

test("fetchServedPaths: valid spec → its path keys", async () => {
  const fetcher: SpecFetcher = async () => ({
    openapi: "3.0.0",
    info: { title: "x", version: "1" },
    paths: { "/api/v1/bookmark/": {}, "/api/v1/bookmark/{id}": {} },
  });

  const paths = await fetchServedPaths("http://x/swagger/json", fetcher);

  expect(paths).toEqual(["/api/v1/bookmark/", "/api/v1/bookmark/{id}"]);
});

test("fetchServedPaths: unreachable / throwing fetch → null (inconclusive, non-blocking)", async () => {
  const fetcher: SpecFetcher = async () => {
    throw new Error("ECONNREFUSED");
  };

  expect(await fetchServedPaths("http://x/swagger/json", fetcher)).toBeNull();
});

test("fetchServedPaths: 2xx body that is NOT an OpenAPI spec → null (never trust garbage)", async () => {
  const fetcher: SpecFetcher = async () => ({ hello: "world" });

  expect(await fetchServedPaths("http://x/swagger/json", fetcher)).toBeNull();
});
