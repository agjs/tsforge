import { test, expect } from "bun:test";
import { isRecord, isArray, errorMessage } from "../src/lib/guards";

test("isRecord and isArray narrow without a type assertion", () => {
  expect(isRecord({ a: 1 })).toBe(true);
  expect(isRecord([])).toBe(true); // an array IS an object
  expect(isRecord(null)).toBe(false);
  expect(isRecord("x")).toBe(false);
  expect(isArray([1])).toBe(true);
  expect(isArray({})).toBe(false);
});

test("errorMessage prefers a real message, then the raw string", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
  expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
  expect(errorMessage("plain failure")).toBe("plain failure");
});

test("errorMessage describes a plain object instead of [object Object]", () => {
  // The legibility bug this exists for: String({code:500}) tells an operator
  // nothing.
  expect(errorMessage({ code: 500, detail: "upstream" })).toContain("500");
  expect(errorMessage({ code: 500 })).not.toBe("[object Object]");
});

// It runs INSIDE a catch, after the failure has already been contained, so throwing
// here would abort the very batch the catch exists to keep alive. Every one of these
// makes JSON.stringify throw or return undefined.
test("errorMessage is total — it never throws, whatever was thrown", () => {
  const circular: Record<string, unknown> = {};

  circular.self = circular;

  const throwingToJson = {
    toJSON() {
      throw new Error("nope");
    },
  };
  const throwingToString = {
    toString() {
      throw new Error("nope");
    },
  };

  // A REVOKED proxy throws on every operation, including `instanceof` and
  // Object.prototype.toString — the cases a guard around only the stringify misses.
  const revocable = Proxy.revocable({}, {});

  revocable.revoke();

  const throwingTag = {
    get [Symbol.toStringTag](): string {
      throw new Error("nope");
    },
  };

  for (const value of [
    circular,
    throwingToJson,
    throwingToString,
    revocable.proxy,
    throwingTag,
    undefined,
    null,
    Symbol("s"),
    10n,
    () => undefined,
    Number.NaN,
  ]) {
    expect(typeof errorMessage(value)).toBe("string");
  }
});
