import { test, expect, afterEach } from "bun:test";
import { toolsFor } from "../src/loop";

const names = (tools: { function: { name: string } }[]): string[] =>
  tools.map((t) => t.function.name);

afterEach(() => {
  delete process.env.TSFORGE_NO_LSP_TOOLS;
  delete process.env.TSFORGE_WEB;
});

test("scratch (no existing code) gets only the base tools — no LSP nav set", () => {
  // Regression: handing the 7 LSP nav tools to a scratch create-from-spec task
  // diluted the create path and stalled money. See lsp-tools-regress-scratch.
  const tools = toolsFor(false);

  expect(names(tools).sort()).toEqual([
    "create",
    "edit",
    "edit_lines",
    "read",
    "run",
  ]);
});

test("existing code gets the base tools PLUS the LSP nav set", () => {
  const tools = toolsFor(true);
  const n = names(tools);

  expect(n).toContain("create");
  expect(n).toContain("search");
  expect(n).toContain("find_references");
  expect(n).toContain("symbol_search");
  expect(n).toContain("rename_symbol");
  expect(tools.length).toBeGreaterThan(4);
});

test("TSFORGE_NO_LSP_TOOLS=1 forces base-only even with existing code", () => {
  process.env.TSFORGE_NO_LSP_TOOLS = "1";
  expect(names(toolsFor(true)).sort()).toEqual([
    "create",
    "edit",
    "edit_lines",
    "read",
    "run",
  ]);
});

test("web tools are absent unless TSFORGE_WEB=1", () => {
  const n = names(toolsFor(true));

  expect(n).not.toContain("web_fetch");
  expect(n).not.toContain("web_search");
});

test("TSFORGE_WEB=1 exposes both free web tools (no key required)", () => {
  process.env.TSFORGE_WEB = "1";
  const n = names(toolsFor(true));

  expect(n).toContain("web_fetch");
  expect(n).toContain("web_search");
});

test("web tools are available on scratch tasks too when enabled", () => {
  process.env.TSFORGE_WEB = "1";
  const n = names(toolsFor(false));

  expect(n).toContain("web_fetch");
  expect(n).toContain("web_search");
});
