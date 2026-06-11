import { test, expect } from "bun:test";
import {
  routeFileName,
  routeComponentName,
  routeStub,
  materializeRoutes,
  normalizeRoutePath,
  asRoutePaths,
  routePathFromFile,
  crawlableRoutePaths,
} from "../src/web-routes";

test("path → TanStack file-based filename (index, nested dot, $param, create)", () => {
  expect(routeFileName("/")).toBe("src/routes/index.tsx");
  expect(routeFileName("/accounts")).toBe("src/routes/accounts.tsx");
  expect(routeFileName("/accounts/$accountId")).toBe(
    "src/routes/accounts.$accountId.tsx"
  );
  expect(routeFileName("/accounts/create")).toBe(
    "src/routes/accounts.create.tsx"
  );
  expect(routeFileName("/settings/profile")).toBe(
    "src/routes/settings.profile.tsx"
  );
});

test("path → a valid, distinct PascalCase component name (never `Route`)", () => {
  expect(routeComponentName("/")).toBe("IndexPage");
  expect(routeComponentName("/accounts")).toBe("AccountsPage");
  expect(routeComponentName("/accounts/$accountId")).toBe(
    "AccountsAccountIdPage"
  );
  expect(routeComponentName("/deals/create")).toBe("DealsCreatePage");
  // must be a valid identifier (starts with a letter, alphanumerics only)
  expect(routeComponentName("/accounts/$accountId")).toMatch(
    /^[A-Za-z][A-Za-z0-9]*$/
  );
});

test("stub is a complete, gate-shaped route file (createFileRoute + one component)", () => {
  const stub = routeStub("/accounts/$accountId");

  expect(stub).toContain(
    'import { createFileRoute } from "@tanstack/react-router";'
  );
  expect(stub).toContain('createFileRoute("/accounts/$accountId")(');
  expect(stub).toContain("component: AccountsAccountIdPage,");
  expect(stub).toContain("function AccountsAccountIdPage() {");
  // the component name must match what the Route references
  expect(stub).toContain("component: AccountsAccountIdPage");
  // carries the stub sentinel so the gate can fail an UNFILLED route
  expect(stub).toContain("data-tsforge-stub");
});

test("materializeRoutes writes one stub per declared path, keyed by filename", () => {
  const out = materializeRoutes([
    "/",
    "/accounts",
    "/accounts/$accountId",
    "/accounts/create",
  ]);

  expect(Object.keys(out).sort()).toEqual([
    "src/routes/accounts.$accountId.tsx",
    "src/routes/accounts.create.tsx",
    "src/routes/accounts.tsx",
    "src/routes/index.tsx",
  ]);
});

test("normalizeRoutePath: leading slash enforced, trailing stripped, root stable", () => {
  expect(normalizeRoutePath("accounts")).toBe("/accounts");
  expect(normalizeRoutePath("/accounts/")).toBe("/accounts");
  expect(normalizeRoutePath("/")).toBe("/");
  expect(normalizeRoutePath("")).toBe("/");
});

test("routePathFromFile: static routes → URL, dynamic/root → null (uncrawlable)", () => {
  expect(routePathFromFile("index.tsx")).toBe("/");
  expect(routePathFromFile("accounts.tsx")).toBe("/accounts");
  expect(routePathFromFile("accounts.create.tsx")).toBe("/accounts/create");
  expect(routePathFromFile("settings.profile.tsx")).toBe("/settings/profile");
  // can't visit these statically:
  expect(routePathFromFile("__root.tsx")).toBeNull();
  expect(routePathFromFile("accounts.$accountId.tsx")).toBeNull();
  expect(routePathFromFile("contacts.$contactId.edit.tsx")).toBeNull();
});

test("crawlableRoutePaths skips root + dynamic, dedupes", () => {
  expect(
    crawlableRoutePaths([
      "__root.tsx",
      "index.tsx",
      "accounts.tsx",
      "accounts.$accountId.tsx",
      "accounts.create.tsx",
    ])
  ).toEqual(["/", "/accounts", "/accounts/create"]);
});

test("asRoutePaths validates + normalizes; junk → [] so the tool can reject", () => {
  expect(asRoutePaths(["/a", "b", "  "])).toEqual(["/a", "/b"]);
  expect(asRoutePaths("nope")).toEqual([]);
  expect(asRoutePaths([1, 2, 3])).toEqual([]);
  expect(asRoutePaths([])).toEqual([]);
});
