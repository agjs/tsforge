import { test, expect, afterEach } from "bun:test";
import { toolsFor } from "../src/loop";

const names = (tools: { function: { name: string } }[]): string[] =>
  tools.map((t) => t.function.name);

afterEach(() => {
  delete process.env.TSFORGE_NO_LSP_TOOLS;
  delete process.env.TSFORGE_WEB;
  delete process.env.TSFORGE_NO_GIT_TOOL;
  delete process.env.TSFORGE_SCRIPT;
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

test("existing code exposes git_context", () => {
  expect(names(toolsFor(true))).toContain("git_context");
});

test("TSFORGE_NO_LSP_TOOLS=1 forces base-only — but git_context survives", () => {
  // git_context is NOT an LSP tool (no tsconfig needed); it's gated on history,
  // so it stays on existing-code runs even when the LSP nav set is withheld.
  process.env.TSFORGE_NO_LSP_TOOLS = "1";
  expect(names(toolsFor(true)).sort()).toEqual([
    "create",
    "edit",
    "edit_lines",
    "git_context",
    "read",
    "run",
  ]);
});

test("git_context is absent on scratch (no history) and removable by flag", () => {
  expect(names(toolsFor(false))).not.toContain("git_context");

  process.env.TSFORGE_NO_GIT_TOOL = "1";
  expect(names(toolsFor(true))).not.toContain("git_context");
});

test("web tools are absent unless TSFORGE_WEB=1", () => {
  const n = names(toolsFor(true));

  expect(n).not.toContain("web_fetch");
  expect(n).not.toContain("web_search");
  expect(n).not.toContain("web_browse");
  expect(n).not.toContain("package_info");
  expect(n).not.toContain("package_docs");
});

test("TSFORGE_WEB=1 exposes keyless web/package research tools", () => {
  process.env.TSFORGE_WEB = "1";
  const n = names(toolsFor(true));

  expect(n).toContain("web_fetch");
  expect(n).toContain("web_search");
  expect(n).toContain("web_browse");
  expect(n).toContain("package_info");
  expect(n).toContain("package_docs");
});

test("web tools are available on scratch tasks too when enabled", () => {
  process.env.TSFORGE_WEB = "1";
  const n = names(toolsFor(false));

  expect(n).toContain("web_fetch");
  expect(n).toContain("web_search");
  expect(n).toContain("web_browse");
  expect(n).toContain("package_info");
  expect(n).toContain("package_docs");
});

test("the script tool is absent unless TSFORGE_SCRIPT=1", () => {
  expect(names(toolsFor(true))).not.toContain("script");
  expect(names(toolsFor(false))).not.toContain("script");
});

test("TSFORGE_SCRIPT=1 exposes the script tool on scratch and existing code", () => {
  process.env.TSFORGE_SCRIPT = "1";

  expect(names(toolsFor(true))).toContain("script");
  expect(names(toolsFor(false))).toContain("script");
});
