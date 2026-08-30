import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("collapses runs of non-alphanumerics to a single hyphen", () => {
  expect(slugify("Hello  World!")).toBe("hello-world");
});
