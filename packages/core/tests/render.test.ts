import { test, expect } from "bun:test";
import { renderEvent } from "../src/render";

test("renders a create as a guttered block with the content", () => {
  const out = renderEvent(
    {
      kind: "create",
      task: "1",
      message: "create todo.ts",
      file: "todo.ts",
      content: "export const x = 1;\nconst y = 2;",
    },
    { color: false }
  );

  expect(out).toContain("create todo.ts");
  expect(out).toContain("export const x = 1;");
  expect(out).toContain("const y = 2;");
  expect(out).not.toContain("["); // no ANSI when color:false
});

test("renders an edit as a -/+ diff", () => {
  const out = renderEvent(
    {
      kind: "edit",
      task: "1",
      message: "edit a.ts",
      file: "a.ts",
      oldString: "foo",
      newString: "bar",
    },
    { color: false }
  );

  expect(out).toContain("- foo");
  expect(out).toContain("+ bar");
});

test("emits ANSI codes when color is on", () => {
  const out = renderEvent(
    { kind: "done", task: "1", message: "done" },
    { color: true }
  );

  expect(out).toContain("[");
});

test("passes tokens through verbatim in plain mode (logs)", () => {
  expect(
    renderEvent(
      { kind: "token", task: "1", message: "hello" },
      { color: false }
    )
  ).toBe("hello");
});
