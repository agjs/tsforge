import { test, expect } from "bun:test";
import { BORINGSTACK_BUILD_SESSION } from "../src/loop/boringstack/build-config";

// headless-build.ts spreads BORINGSTACK_BUILD_SESSION into Session.create, so these
// pins are what stops a flag being silently dropped from the production build path —
// the gap a Session-only advertisement test cannot cover (it bypasses headless-build).

test("the BoringStack build offers the check tool (WS-G) — offerCheck must stay true", () => {
  expect(BORINGSTACK_BUILD_SESSION.offerCheck).toBe(true);
});

test("the BoringStack build keeps its convention library + drive-to-green contract", () => {
  expect(BORINGSTACK_BUILD_SESSION.pullConventions).toBe(true);
  expect(BORINGSTACK_BUILD_SESSION.executionMode).toBe("drive-to-green");
});
