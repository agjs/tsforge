import { test, expect } from "bun:test";
import { parseVersion, meetsPinned } from "../scripts/check-bun-version";

test("parseVersion strips range prefixes and the bun@ tag", () => {
  expect(parseVersion("1.3.14")).toEqual([1, 3, 14]);
  expect(parseVersion(">=1.3.14")).toEqual([1, 3, 14]);
  expect(parseVersion("^1.3.14")).toEqual([1, 3, 14]);
  expect(parseVersion("bun@1.3.14")).toEqual([1, 3, 14]);
  // A malformed part can't crash — it degrades to 0.
  expect(parseVersion("1.x.3")).toEqual([1, 0, 3]);
});

test("meetsPinned passes the pin and equal-or-higher, fails lower", () => {
  expect(meetsPinned("1.3.14", ">=1.3.14")).toBe(true); // exactly the pin
  expect(meetsPinned("1.3.20", ">=1.3.14")).toBe(true); // higher patch
  expect(meetsPinned("1.4.0", ">=1.3.14")).toBe(true); // higher minor
  expect(meetsPinned("2.0.0", ">=1.3.14")).toBe(true); // higher major
  expect(meetsPinned("1.3.10", ">=1.3.14")).toBe(false); // the EADDRINUSE build
  expect(meetsPinned("1.2.99", ">=1.3.14")).toBe(false); // lower minor
});
