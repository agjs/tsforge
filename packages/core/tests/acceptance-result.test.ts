import { test, expect } from "bun:test";
import { summarize } from "../src/loop/acceptance/acceptance-outcome";
import type { IAcceptanceResult } from "../src/loop/acceptance/acceptance.types";

test("summarize: empty results → ok=false", () => {
  const outcome = summarize([]);

  expect(outcome.ok).toBe(false);
  expect(outcome.results).toEqual([]);
  expect(outcome.detail).toBe("no acceptance checks ran");
  expect(outcome.infraError).toBeUndefined();
});

test("summarize: all passing results → ok=true", () => {
  const results: IAcceptanceResult[] = [
    { entity: "Company", step: "nav", ok: true, detail: "nav worked" },
    { entity: "Company", step: "list", ok: true, detail: "list displayed" },
    {
      entity: "Company",
      step: "create",
      ok: true,
      detail: "create form opened",
    },
  ];

  const outcome = summarize(results);

  expect(outcome.ok).toBe(true);
  expect(outcome.results).toEqual(results);
  expect(outcome.detail).toBeUndefined();
  expect(outcome.infraError).toBeUndefined();
});

test("summarize: first failing result sets ok=false", () => {
  const results: IAcceptanceResult[] = [
    { entity: "Company", step: "nav", ok: true, detail: "nav worked" },
    {
      entity: "Company",
      step: "create",
      ok: false,
      detail: "create form never appeared",
    },
    { entity: "Company", step: "persist", ok: true, detail: "save succeeded" },
  ];

  const outcome = summarize(results);

  expect(outcome.ok).toBe(false);
  expect(outcome.results).toEqual(results);
  expect(outcome.detail).toBe("create form never appeared");
  expect(outcome.infraError).toBeUndefined();
});

test("summarize: multiple failures → ok=false, first failure bubbled", () => {
  const results: IAcceptanceResult[] = [
    { entity: "Company", step: "nav", ok: true, detail: "nav worked" },
    {
      entity: "Company",
      step: "create",
      ok: false,
      detail: "create button not found",
    },
    {
      entity: "Company",
      step: "persist",
      ok: false,
      detail: "form submission failed",
    },
  ];

  const outcome = summarize(results);

  expect(outcome.ok).toBe(false);
  expect(outcome.results).toEqual(results);
  expect(outcome.detail).toBe("create button not found");
  expect(outcome.infraError).toBeUndefined();
});

test("summarize: infraError not set by summarize", () => {
  const results: IAcceptanceResult[] = [
    { entity: "Contact", step: "nav", ok: true, detail: "nav worked" },
  ];

  const outcome = summarize(results);

  expect(outcome.infraError).toBeUndefined();
});
