import { test, expect } from "bun:test";
import { StreamingMarkdown, renderMarkdown } from "../src/render";

test("prose flushes per completed line; the partial tail is held", () => {
  const s = new StreamingMarkdown();

  expect(s.push("hello ", false)).toBe("\n"); // opening separator only
  expect(s.push("world\nnext", false)).toBe("hello world\n");
  expect(s.flush(false)).toBe("next\n");
});

test("first push opens with a blank separator once per turn", () => {
  const s = new StreamingMarkdown();

  expect(s.push("a\n", false)).toBe("\na\n");
  expect(s.push("b\n", false)).toBe("b\n");
  s.reset();
  expect(s.push("c\n", false)).toBe("\nc\n");
});

test("a fenced code block is held until it closes, then emitted whole", () => {
  const s = new StreamingMarkdown();

  expect(s.push("```ts\nconst x", false)).toBe("\n");
  expect(s.push(" = 1;\n", false)).toBe("");
  expect(s.push("```\n", false)).toBe("const x = 1;\n");
});

test("a GFM table is held and rendered as the same box table as the full render", () => {
  const md = "| a | b |\n|---|---|\n| 1 | 2 |";
  const s = new StreamingMarkdown();

  let out = s.push(`${md}\n`, true);

  expect(out).toBe("\n"); // still held — could be more rows coming
  out = s.push("done\n", true);

  // The streamed table block must equal what the settled renderer produces.
  expect(out).toContain(renderMarkdown(md, true).trim());
  expect(out).toContain("done");
  expect(out).toContain("┌"); // a real box table, not pipe soup
});

test("flush emits a trailing held table (answer ends with a table)", () => {
  const s = new StreamingMarkdown();

  s.push("| a | b |\n|---|---|\n| 1 | 2 |\n", true);

  const out = s.flush(true);

  expect(out).toContain("┌");
  expect(out).toContain("1");
});

test("sawContent latches on push and clears on reset", () => {
  const s = new StreamingMarkdown();

  expect(s.sawContent).toBe(false);
  s.push("x", false);
  expect(s.sawContent).toBe(true);
  s.reset();
  expect(s.sawContent).toBe(false);
});

test("abort mid-line: flush emits the partial line and an unclosed fence raw", () => {
  const s = new StreamingMarkdown();

  s.push("```\ncode line\npart", false);

  const out = s.flush(false);

  expect(out).toContain("code line");
  expect(out).toContain("part");
});

test("color:false passes prose through unstyled", () => {
  const s = new StreamingMarkdown();

  expect(s.push("**bold** and `code`\n", false)).toBe(
    "\n**bold** and `code`\n"
  );
});

test("inline code uses zinc, never sky-blue brand", () => {
  const s = new StreamingMarkdown();
  const out = s.push("move to the `updatedAt` task.\n", true);

  expect(out).toContain("updatedAt");
  // brandLight #60a5fa — the blue the user keeps spotting in agent prose.
  expect(out).not.toContain("38;2;96;165;250");
  expect(out).not.toContain("38;2;59;130;246");
  // chromeLight #f4f4f5 — quiet zinc on the dark canvas.
  expect(out).toContain("38;2;244;244;245");
});
