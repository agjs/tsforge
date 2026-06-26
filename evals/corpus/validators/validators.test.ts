import { test, expect } from "bun:test";
import { isNonEmpty } from "./nonEmpty";
import { isPositive } from "./positive";
import { isEmail } from "./email";
import { isSlug } from "./slug";
import { isHexColor } from "./hexColor";
import { isUuid } from "./uuid";

const valid: ReadonlyArray<[string, (v: string) => boolean, string]> = [
  ["nonEmpty", isNonEmpty, "x"],
  ["positive", isPositive, "3"],
  ["email", isEmail, "a@b.co"],
  ["slug", isSlug, "my-post-1"],
  ["hexColor", isHexColor, "#a1b2c3"],
  ["uuid", isUuid, "123e4567-e89b-12d3-a456-426614174000"],
];

const invalid: ReadonlyArray<[string, (v: string) => boolean, string]> = [
  ["nonEmpty", isNonEmpty, "   "],
  ["positive", isPositive, "-2"],
  ["email", isEmail, "nope"],
  ["slug", isSlug, "Not A Slug"],
  ["hexColor", isHexColor, "#zzz"],
  ["uuid", isUuid, "123"],
];

for (const [name, fn, ok] of valid) {
  test(`${name} accepts a valid value`, () => {
    expect(fn(ok)).toBe(true);
  });
}

for (const [name, fn, bad] of invalid) {
  test(`${name} rejects an invalid value`, () => {
    expect(fn(bad)).toBe(false);
  });
}
