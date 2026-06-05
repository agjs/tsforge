import { test, expect } from "bun:test";
import { repairArgs } from "../src/agent/tool-repair";

test("drops null/undefined values (model sends null for an optional)", () => {
  const { args, applied } = repairArgs({ file: "a.ts", limit: null });

  expect(args).toEqual({ file: "a.ts" });
  expect(applied).toContain("drop-null:limit");
});

test("unwraps a degenerate markdown auto-link on a path (the chat-leak bug)", () => {
  const { args, applied } = repairArgs({
    file: "[notes.md](notes.md)",
  });

  expect(args.file).toBe("notes.md");
  expect(applied).toContain("unwrap-autolink:file");
});

test("unwraps an auto-link even when the url carries an http(s) prefix", () => {
  const { args } = repairArgs({ file: "[notes.md](http://notes.md)" });

  expect(args.file).toBe("notes.md");
});

test("leaves a REAL markdown link (distinct text/url) untouched", () => {
  const real = "[click here](https://example.com/page)";
  const { args, applied } = repairArgs({ content: real });

  expect(args.content).toBe(real);
  expect(applied).toHaveLength(0);
});

test("never rewrites valid free-text content (no greedy JSON parsing)", () => {
  // A content field that happens to be JSON-shaped must pass through unchanged —
  // validate-then-repair means this only runs after a parse FAILURE anyway, and
  // even then we don't blanket-parse strings.
  const { args, applied } = repairArgs({
    file: "a.ts",
    content: '["a","b"]',
  });

  expect(args.content).toBe('["a","b"]');
  expect(applied).toHaveLength(0);
});
