import { test, expect } from "bun:test";
import {
  isLocaleCommonJson,
  localeKeyDelta,
  boringstackEditGuard,
} from "../src/loop/boringstack/i18n-guard";

const full = JSON.stringify({
  features: {
    contact: {
      title: "Contacts",
      empty: "No contacts yet.",
      createError: "Could not create contact",
      deleteError: "Could not delete contact",
      confirmDelete: "Are you sure?",
    },
  },
});

const gutted = JSON.stringify({
  features: { contact: { title: "Contacts", empty: "No contacts yet." } },
});

const EN = "apps/ui/src/lib/i18n/locales/en/common.json";

test("isLocaleCommonJson matches boringstack locale message files only", () => {
  expect(isLocaleCommonJson(EN)).toBe(true);
  expect(
    isLocaleCommonJson("apps/ui/src/lib/i18n/locales/de/common.json")
  ).toBe(true);
  expect(
    isLocaleCommonJson("apps/ui/src/features/contact/ContactPage.tsx")
  ).toBe(false);
  expect(isLocaleCommonJson("apps/api/src/config/env/schema.ts")).toBe(false);
});

test("localeKeyDelta reports removed and added feature keys", () => {
  const delta = localeKeyDelta(full, gutted);

  expect([...delta.removed].sort()).toEqual([
    "contact.confirmDelete",
    "contact.createError",
    "contact.deleteError",
  ]);
  expect(delta.added).toEqual([]);
});

test("guard VETOES the CRM anti-pattern: gutting the vocabulary to title+empty", () => {
  const veto = boringstackEditGuard(EN, full, gutted);

  expect(veto).not.toBeNull();
  expect(veto?.reason).toBe("i18n-destructive-delete");
  expect(veto?.message).toContain("REJECTED");
  expect(veto?.message).toContain("contact.createError");
  expect(veto?.message).toContain("WIRE");
});

test("guard ALLOWS a rename (removes AND adds keys)", () => {
  const renamed = JSON.stringify({
    features: {
      contact: {
        title: "Contacts",
        empty: "No contacts yet.",
        createError: "Could not create contact",
        deleteError: "Could not delete contact",
        removeConfirm: "Are you sure?", // confirmDelete → removeConfirm
      },
    },
  });

  expect(boringstackEditGuard(EN, full, renamed)).toBeNull();
});

test("guard ALLOWS adding keys (the wire-up direction)", () => {
  expect(boringstackEditGuard(EN, gutted, full)).toBeNull();
});

test("guard is a NO-OP for non-locale files", () => {
  expect(
    boringstackEditGuard(
      "apps/ui/src/features/contact/ContactPage.tsx",
      full,
      gutted
    )
  ).toBeNull();
});

test("guard fails OPEN on malformed JSON (never blocks on a parse error)", () => {
  expect(boringstackEditGuard(EN, full, "{ not valid json")).toBeNull();
  expect(boringstackEditGuard(EN, "{ broken", gutted)).toBeNull();
});
