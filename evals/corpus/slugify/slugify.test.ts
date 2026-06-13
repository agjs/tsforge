import { test, expect } from "bun:test";
import { slugify } from "./slugify";

test("lowercases and hyphenates", () => {
  expect(slugify("Hello World")).toBe("hello-world");
});

test("collapses punctuation runs and trims hyphens", () => {
  expect(slugify("  Hello, World!!  ")).toBe("hello-world");
});

test("folds accents to ASCII", () => {
  expect(slugify("Café del Mar")).toBe("cafe-del-mar");
});
