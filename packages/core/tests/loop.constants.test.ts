import { expect, test } from "bun:test";
import { DEFAULT_TEMPERATURE } from "../src/loop/loop.constants";

test("DEFAULT_TEMPERATURE is the global main-turn default", () => {
  expect(DEFAULT_TEMPERATURE).toBe(0.2);
});
