import { test, expect } from "bun:test";
import { interimCheckContent } from "../src/loop/session";
import type { ErrorSet } from "../src/validate";

test("interimCheckContent surfaces the raw error message AND the curated fix recipe", () => {
  const errors: ErrorSet = [
    {
      key: "failure:apps/ui/src/lib/i18n/locales/en/common.json::i18n-locale-keys-used:dead",
      file: "apps/ui/src/lib/i18n/locales/en/common.json",
      rule: "i18n-locale-keys-used",
      message:
        "Locale key `features.task.deleteError` is defined but never referenced in src — dead translation surface (remove it from every locale, or wire it up).",
    },
  ];

  const content = interimCheckContent(errors);

  // The raw error is still shown…
  expect(content).toContain("features.task.deleteError");
  // …AND the curated recipe (ruleHelp) is appended, steering wire-up not delete.
  expect(content.toLowerCase()).toContain("wire it up");
  expect(content.toLowerCase()).toContain("never delete");
});

test("interimCheckContent is just the note + errors when no rule has a curated doc", () => {
  const errors: ErrorSet = [
    {
      key: "k",
      rule: "some-unknown-rule-with-no-doc",
      message: "a raw failure",
    },
  ];

  const content = interimCheckContent(errors);

  expect(content).toContain("a raw failure");
  // No curated doc → no guidance block appended (content ends at the raw error).
  expect(content.endsWith("a raw failure")).toBe(true);
});

test("interimCheckContent caps the surfaced errors so a wall can't blow the prompt", () => {
  const errors: ErrorSet = Array.from({ length: 40 }, (_, i) => ({
    key: `k${String(i)}`,
    message: `err-${String(i)}`,
  }));

  const content = interimCheckContent(errors);

  // First 20 shown, 21st (index 20) dropped.
  expect(content).toContain("err-19");
  expect(content).not.toContain("err-20");
});
