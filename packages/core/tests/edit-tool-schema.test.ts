import { test, expect } from "bun:test";
import { EDIT_TOOL } from "../src/agent/agent.constants";

test("edit tool advertises the atomic multi-site batch that its backend supports", () => {
  const parameters = EDIT_TOOL.function.parameters;

  expect(parameters.properties.edits.type).toBe("array");
  expect(parameters.properties.edits.items.required).toEqual([
    "oldString",
    "newString",
  ]);
  expect(parameters.anyOf).toContainEqual({ required: ["edits"] });
  expect(EDIT_TOOL.function.description).toContain("batch is atomic");
  expect(EDIT_TOOL.function.description).toContain("surrounding lines");
});
