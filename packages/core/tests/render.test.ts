import { test, expect } from "bun:test";
import { renderEvent, renderStatus, type IStatusInfo } from "../src/render";

function statusInfo(over: Partial<IStatusInfo> = {}): IStatusInfo {
  return {
    model: "m",
    contextTokens: 0,
    contextWindow: 100,
    turns: 0,
    elapsedMs: 0,
    status: "ready",
    scope: "entire workspace",
    ...over,
  };
}

test("status line shows the current mode as a ◆ chip", () => {
  const out = renderStatus(statusInfo({ mode: "plan" }), { color: false });

  expect(out).toContain("◆ plan");
});

test("status line omits the mode chip when no mode is set", () => {
  const out = renderStatus(statusInfo(), { color: false });

  expect(out).not.toContain("◆");
});

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

test("content tokens stream live in color mode, stay silent in plain mode", () => {
  const tok = (message: string): Parameters<typeof renderEvent>[0] => ({
    kind: "token",
    task: "1",
    message,
    channel: "content",
  });

  expect(renderEvent(tok("answer "), { color: true })).toBe("\n");
  expect(renderEvent(tok("text\n"), { color: true })).toContain("answer text");
  expect(renderEvent(tok("ignored"), { color: false })).toBe("");

  // Settle the module-level stream so later tests start clean.
  renderEvent({ kind: "message", task: "1", message: "answer text" });
});

test("a message after streamed content does not re-print the body", () => {
  renderEvent(
    { kind: "token", task: "1", message: "the answer\n", channel: "content" },
    { color: true }
  );

  const out = renderEvent(
    { kind: "message", task: "1", message: "the answer" },
    { color: true }
  );

  expect(out).not.toContain("the answer");
});

test("a message with no streamed content still renders in full", () => {
  const out = renderEvent(
    { kind: "message", task: "1", message: "plain answer" },
    { color: true }
  );

  expect(out).toContain("plain answer");
});

test("a non-token event flushes a held partial content line first", () => {
  renderEvent(
    { kind: "token", task: "1", message: "partial tail", channel: "content" },
    { color: true }
  );

  const out = renderEvent(
    { kind: "done", task: "1", message: "all green" },
    { color: true }
  );

  expect(out).toContain("partial tail");
  expect(out).toContain("all green");

  renderEvent({ kind: "message", task: "1", message: "x" }); // settle stream
});
