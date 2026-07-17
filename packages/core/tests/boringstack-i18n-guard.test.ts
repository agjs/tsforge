import { test, expect } from "bun:test";
import {
  isLocaleCommonJson,
  makeBoringstackEditGuard,
} from "../src/loop/boringstack/i18n-guard";

const EN = "apps/ui/src/lib/i18n/locales/en/common.json";

// The scaffold-seeded minimal file (title + empty) vs. after the model adds a
// full error/confirm vocabulary.
const minimal = JSON.stringify({
  features: { contact: { title: "Contacts", empty: "None." } },
});

const full = JSON.stringify({
  features: {
    contact: {
      title: "Contacts",
      empty: "None.",
      createError: "c",
      deleteError: "d",
      confirmDelete: "q",
    },
  },
});

test("isLocaleCommonJson matches boringstack locale message files only", () => {
  expect(isLocaleCommonJson(EN)).toBe(true);
  expect(
    isLocaleCommonJson("apps/ui/src/lib/i18n/locales/de/common.json")
  ).toBe(true);
  expect(
    isLocaleCommonJson("apps/ui/src/features/contact/ContactPage.tsx")
  ).toBe(false);
  expect(isLocaleCommonJson("apps/api/src/config/env/schema.ts")).toBe(false);
  // No path boundary before i18n → not a match (guards against `myi18n/...`).
  expect(isLocaleCommonJson("myi18n/locales/en/common.json")).toBe(false);
});

test("VETOES deleting keys the SESSION authored (add-then-delete, the real pattern)", () => {
  const guard = makeBoringstackEditGuard();

  // Turn 1: the model ADDS the vocabulary → allowed, recorded as session-authored.
  expect(guard(EN, minimal, full)).toBeNull();

  // Turn 2: the model DELETES what it just wrote → vetoed.
  const veto = guard(EN, full, minimal);

  expect(veto).not.toBeNull();
  expect(veto?.reason).toBe("i18n-destructive-delete");
  expect(veto?.message).toContain("createError");
  expect(veto?.message).toContain("WIRE");
});

test("ALLOWS removing a PRE-EXISTING key the session did NOT author (no deadlock)", () => {
  const guard = makeBoringstackEditGuard();

  // The guard never witnessed these keys being added → they are pre-existing /
  // obsolete as far as it knows → their removal is allowed (the over-block a
  // reviewer flagged: a no-baseline guard would wrongly veto this).
  expect(guard(EN, full, minimal)).toBeNull();
});

test("ALLOWS adding keys (the wire-up direction)", () => {
  const guard = makeBoringstackEditGuard();

  expect(guard(EN, minimal, full)).toBeNull();
});

test("a single throwaway addition does NOT license a NET deletion of authored keys", () => {
  const guard = makeBoringstackEditGuard();

  guard(EN, minimal, full); // author createError/deleteError/confirmDelete

  // Delete TWO authored keys while adding ONE throwaway → net loss of authored
  // keys (2 removed > 1 added) → vetoed. (A balanced 1-for-1 is allowed by design
  // — it's indistinguishable from a rename and self-limiting, since a throwaway
  // is itself an unused key the gate then flags.)
  const after = JSON.stringify({
    features: {
      contact: {
        title: "Contacts",
        empty: "None.",
        createError: "c",
        note: "throwaway",
      },
    },
  });

  const veto = guard(EN, full, after);

  expect(veto).not.toBeNull();
  expect(veto?.reason).toBe("i18n-destructive-delete");
});

test("ALLOWS a rename of an authored key (remove old + add new — no deadlock)", () => {
  const guard = makeBoringstackEditGuard();

  guard(EN, minimal, full); // author the vocabulary

  // Rename deleteError → deleteFailed: removes 1 authored key, adds 1. A balanced
  // rename must be allowed so the now-unused old key can't deadlock the gate.
  const renamed = JSON.stringify({
    features: {
      contact: {
        title: "Contacts",
        empty: "None.",
        createError: "c",
        deleteFailed: "d",
        confirmDelete: "q",
      },
    },
  });

  expect(guard(EN, full, renamed)).toBeNull();
});

test("seeds authorship from a NEW-file create (empty before) → a later gut is vetoed", () => {
  const guard = makeBoringstackEditGuard();

  // `create` writes the vocab into a new locale file (empty before): all keys are
  // session-authored, closing the create→gut bypass.
  expect(guard(EN, "", full)).toBeNull();

  // A later edit that guts it is caught even though the keys arrived via create.
  expect(guard(EN, full, minimal)).not.toBeNull();
});

test("VETOES an edit that leaves the locale file invalid JSON (closes the 2-step bypass)", () => {
  const guard = makeBoringstackEditGuard();
  const veto = guard(EN, full, "{ not valid json");

  expect(veto).not.toBeNull();
  expect(veto?.reason).toBe("i18n-invalid-json");
  expect(veto?.message).toContain("invalid JSON");
});

test("fails OPEN when the BEFORE content is malformed (state it didn't create)", () => {
  const guard = makeBoringstackEditGuard();

  expect(guard(EN, "{ broken", minimal)).toBeNull();
});

test("is a NO-OP for non-locale files", () => {
  const guard = makeBoringstackEditGuard();

  expect(
    guard("apps/ui/src/features/contact/ContactPage.tsx", full, minimal)
  ).toBeNull();
});

test("each build gets independent authorship state (factory, not shared)", () => {
  const guardA = makeBoringstackEditGuard();

  guardA(EN, minimal, full); // A authored the vocab

  const guardB = makeBoringstackEditGuard();

  // B never authored anything → deleting the same keys is allowed for B.
  expect(guardB(EN, full, minimal)).toBeNull();
  // …but still vetoed for A.
  expect(guardA(EN, full, minimal)).not.toBeNull();
});
