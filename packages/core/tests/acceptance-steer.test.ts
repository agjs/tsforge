import { test, expect } from "bun:test";
import { acceptanceSteer } from "../src/loop/acceptance/acceptance-steer";
import type {
  IEntityAcceptance,
  IAcceptanceOutcome,
} from "../src/loop/acceptance/acceptance.types";

const makeEntity = (id: string): IEntityAcceptance => ({
  id,
  key: id.toLowerCase(),
  nav: `${id}s`,
  fields: [
    {
      name: "name",
      type: "string",
      optional: false,
      valid: "test-name",
      invalid: [],
    },
  ],
  shows: ["name"],
  screens: ["list", "form"],
  parents: [],
  negatives: [],
  acceptanceCheck: `test ${id.toLowerCase()}`,
});

test("acceptanceSteer: all-pass outcome returns empty string", () => {
  const entity = makeEntity("Company");
  const outcome: IAcceptanceOutcome = {
    ok: true,
    results: [
      { entity: "Company", step: "nav", ok: true, detail: "" },
      { entity: "Company", step: "list", ok: true, detail: "" },
    ],
  };

  expect(acceptanceSteer(entity, outcome)).toBe("");
});

test("acceptanceSteer: CREATE-fail mentions entity, create step, and persistence expectation", () => {
  const entity = makeEntity("Company");

  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      { entity: "Company", step: "nav", ok: true, detail: "" },
      { entity: "Company", step: "list", ok: true, detail: "" },
      { entity: "Company", step: "create", ok: true, detail: "" },
      {
        entity: "Company",
        step: "persist",
        ok: false,
        detail: "new row did not appear",
      },
    ],
  };

  const steer = acceptanceSteer(entity, outcome);

  expect(steer).toContain("Company");
  expect(steer).toContain("persist");
  expect(steer).toContain("did not appear");
});

test("acceptanceSteer: NAV-fail mentions navigation/reachability", () => {
  const entity = makeEntity("Contact");

  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      { entity: "Contact", step: "nav", ok: false, detail: "menu not found" },
    ],
  };

  const steer = acceptanceSteer(entity, outcome);

  expect(steer).toContain("Contact");
  expect(steer).toContain("nav");
  expect(steer.toLowerCase()).toMatch(/navigat|reach|access/);
});

test("acceptanceSteer: LIST-fail mentions list visibility", () => {
  const entity = makeEntity("Deal");

  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      { entity: "Deal", step: "nav", ok: true, detail: "" },
      {
        entity: "Deal",
        step: "list",
        ok: false,
        detail: "list container not visible",
      },
    ],
  };

  const steer = acceptanceSteer(entity, outcome);

  expect(steer).toContain("Deal");
  expect(steer).toContain("list");
});

test("acceptanceSteer: UPDATE-fail mentions update persistence", () => {
  const entity = makeEntity("Activity");

  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      { entity: "Activity", step: "nav", ok: true, detail: "" },
      { entity: "Activity", step: "list", ok: true, detail: "" },
      { entity: "Activity", step: "create", ok: true, detail: "" },
      { entity: "Activity", step: "persist", ok: true, detail: "" },
      {
        entity: "Activity",
        step: "update",
        ok: false,
        detail: "changes not saved",
      },
    ],
  };

  const steer = acceptanceSteer(entity, outcome);

  expect(steer).toContain("Activity");
  expect(steer).toContain("update");
});

test("acceptanceSteer: DELETE-fail mentions removal", () => {
  const entity = makeEntity("Team");

  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      { entity: "Team", step: "nav", ok: true, detail: "" },
      { entity: "Team", step: "list", ok: true, detail: "" },
      { entity: "Team", step: "create", ok: true, detail: "" },
      { entity: "Team", step: "persist", ok: true, detail: "" },
      {
        entity: "Team",
        step: "delete",
        ok: false,
        detail: "row still visible after delete",
      },
    ],
  };

  const steer = acceptanceSteer(entity, outcome);

  expect(steer).toContain("Team");
  expect(steer).toContain("delete");
});

test("acceptanceSteer: NEGATIVE-fail mentions validation", () => {
  const entity = makeEntity("User");

  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      { entity: "User", step: "nav", ok: true, detail: "" },
      { entity: "User", step: "list", ok: true, detail: "" },
      {
        entity: "User",
        step: "negative",
        ok: false,
        detail: "invalid input was accepted",
      },
    ],
  };

  const steer = acceptanceSteer(entity, outcome);

  expect(steer).toContain("User");
  expect(steer).toContain("negative");
  expect(steer.toLowerCase()).toMatch(/invalid|reject|validation|required/);
});

test("acceptanceSteer: includes outcome.detail if present", () => {
  const entity = makeEntity("Product");

  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      {
        entity: "Product",
        step: "persist",
        ok: false,
        detail: "timeout waiting for API",
      },
    ],
    detail: "timeout waiting for API",
  };

  const steer = acceptanceSteer(entity, outcome);

  expect(steer).toContain("timeout waiting for API");
});

test("acceptanceSteer: first failing step determines steer, not later ones", () => {
  const entity = makeEntity("Note");

  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      {
        entity: "Note",
        step: "create",
        ok: false,
        detail: "create button missing",
      },
      {
        entity: "Note",
        step: "persist",
        ok: false,
        detail: "row not visible",
      },
    ],
  };

  const steer = acceptanceSteer(entity, outcome);

  // Should focus on CREATE (first failure), not PERSIST (second failure)
  expect(steer).toContain("create");
  expect(steer).not.toContain("did not appear");
});

test("acceptanceSteer: CREATE step message mentions form submission", () => {
  const entity = makeEntity("Issue");

  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      {
        entity: "Issue",
        step: "create",
        ok: false,
        detail: "create form not visible",
      },
    ],
  };

  const steer = acceptanceSteer(entity, outcome);

  expect(steer).toContain("Issue");
  expect(steer).toContain("create");
});

test("acceptanceSteer: form-didn't-close failure steers at closing the form on success, NOT at opening/persistence", () => {
  const entity = makeEntity("Bookmark");

  // Real Playwright signature when the create form submits but never hides: the
  // failure is classified "create" (the hidden-assert lives in the create test),
  // but the true fix is closing the form on success — not opening it or fixing persistence.
  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      { entity: "Bookmark", step: "nav", ok: true, detail: "" },
      { entity: "Bookmark", step: "list", ok: true, detail: "" },
      {
        entity: "Bookmark",
        step: "create",
        ok: false,
        detail:
          'TimeoutError: locator.waitFor: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByTestId(\'bookmark-form\') to be hidden\n    24 × locator resolved to visible <form novalidate="" data-testid="bookmark-form">…</form>',
      },
    ],
  };

  const steer = acceptanceSteer(entity, outcome);

  expect(steer).toContain("Bookmark");
  expect(steer).toContain("did not close");
  expect(steer).toContain("onSuccess");
  // Must NOT emit the misleading generic create-step message that tells the model the
  // form failed to OPEN — that opposite steer is the whole bug being fixed here.
  expect(steer).not.toContain("was not visible");
});

test("acceptanceSteer: a genuine form-didn't-OPEN create failure still uses the generic create message", () => {
  const entity = makeEntity("Bookmark");

  // No "to be hidden"/"resolved to visible" signature → NOT a form-close failure;
  // the detail-aware branch must fall through to the generic create-step message.
  const outcome: IAcceptanceOutcome = {
    ok: false,
    results: [
      {
        entity: "Bookmark",
        step: "create",
        ok: false,
        detail: "getByTestId('bookmark-create') not found",
      },
    ],
  };

  const steer = acceptanceSteer(entity, outcome);

  expect(steer).toContain("was not visible");
  expect(steer).not.toContain("did not close");
});
