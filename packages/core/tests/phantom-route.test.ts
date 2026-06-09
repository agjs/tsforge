import { test, expect } from "bun:test";
import { isPhantomRouteError } from "../src/loop/turn";

test("flags the stub-route-tree phantom — `<Link to>` form (TS2322, nav union)", () => {
  // What TanStack Router's `to` resolves to when the route tree is the empty stub —
  // a false TS2322 at write/interim time that `bun run build` erases at the gate.
  expect(
    isPhantomRouteError(
      `Type '"/contacts"' is not assignable to type '"/" | "." | ".."'.`
    )
  ).toBe(true);
  expect(
    isPhantomRouteError(
      'Type \'`/contacts/${string}`\' is not assignable to type \'"/" | "." | ".."\'.'
    )
  ).toBe(true);
});

test("flags the stub phantom — `createFileRoute`/`navigate` form (TS2345, bare `/`)", () => {
  // The other form: the path ARGUMENT checked against the stub's only route, `"/"`.
  expect(
    isPhantomRouteError(
      `Argument of type '"/contacts"' is not assignable to parameter of type '"/"'.`
    )
  ).toBe(true);
  expect(
    isPhantomRouteError(
      `Argument of type '"/contacts/$contactId/edit"' is not assignable to parameter of type '"/"'.`
    )
  ).toBe(true);
});

test("flags the useParams stub phantom (empty `{}`/`never` params)", () => {
  // Route.useParams() against the stub gives empty params → param access fails.
  expect(
    isPhantomRouteError(`Property 'id' does not exist on type '{}'.`)
  ).toBe(true);
  expect(
    isPhantomRouteError(`Property 'handle' does not exist on type 'never'.`)
  ).toBe(true);
  // A real property error on a TYPED object must NOT be masked.
  expect(
    isPhantomRouteError(`Property 'foo' does not exist on type 'IContact'.`)
  ).toBe(false);
});

test("flags the stub phantom regardless of message shape (the whack-a-mole forms)", () => {
  // Reordered nav union (TS2322) — path-prefix matching missed this.
  expect(
    isPhantomRouteError(
      `Type '"/companies/new"' is not assignable to type '"." | ".." | "/"'.`
    )
  ).toBe(true);
  // params excess-property (TS2353) — references ParamsReducerFn.
  expect(
    isPhantomRouteError(
      `Object literal may only specify known properties, and 'id' does not exist in type 'ParamsReducerFn<RouterCore<...>, "PATH", string, "/companies/$id">'.`
    )
  ).toBe(true);
  // createFileRoute constraint (TS2322) — references ConstrainLiteral + __root__.
  expect(
    isPhantomRouteError(
      `Type '"/deals/$id"' is not assignable to type 'ConstrainLiteral<"/deals/$id", "__root__" | "/", "__root__" | "/">'.`
    )
  ).toBe(true);
});

test("does NOT flag a real route error (against the FULL route union)", () => {
  // A genuinely-wrong route errors against the populated tree — the gate must keep
  // catching this, so it must NOT be treated as a phantom.
  expect(
    isPhantomRouteError(
      `Type '"/typo"' is not assignable to type '"/" | "/contacts" | "/deals"'.`
    )
  ).toBe(false);
});

test("does NOT flag unrelated type errors", () => {
  expect(
    isPhantomRouteError("Type 'string' is not assignable to type 'number'.")
  ).toBe(false);
  expect(isPhantomRouteError("Cannot find name 'Badge'.")).toBe(false);
});
