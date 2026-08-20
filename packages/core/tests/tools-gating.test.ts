import { test, expect, afterEach } from "bun:test";
import { toolsFor } from "../src/loop";

const names = (tools: { function: { name: string } }[]): string[] =>
  tools.map((t) => t.function.name);

afterEach(() => {
  delete process.env.TSFORGE_NO_LSP_TOOLS;
  delete process.env.TSFORGE_WEB;
  delete process.env.TSFORGE_NO_GIT_TOOL;
  delete process.env.TSFORGE_NO_SCRIPT;
});

test("scratch (no existing code) gets only the base tools — no LSP nav set", () => {
  // Regression: handing the 7 LSP nav tools to a scratch create-from-spec task
  // diluted the create path and stalled money. See lsp-tools-regress-scratch.
  const tools = toolsFor(false);

  // `delete` rides with create/edit: removing a file you superseded is part of
  // writing, and the shell's `rm` is a critical deny with no alternative.
  expect(names(tools).sort()).toEqual([
    "create",
    "delete",
    "edit",
    "edit_lines",
    "read",
    "run",
    "script",
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
    "delete",
    "edit",
    "edit_lines",
    "git_context",
    "read",
    "run",
    "script",
  ]);
});

test("git_context is absent on scratch (no history) and removable by flag", () => {
  expect(names(toolsFor(false))).not.toContain("git_context");

  process.env.TSFORGE_NO_GIT_TOOL = "1";
  expect(names(toolsFor(true))).not.toContain("git_context");
});

test("git/GitHub tools are absent unless the github capability is on", () => {
  const off = names(toolsFor(true));

  expect(off).not.toContain("github_read");
  expect(off).not.toContain("git_write");
  expect(off).not.toContain("github_write");
});

test("the github capability advertises all three git/GitHub tools", () => {
  const on = names(toolsFor(true, { github: true }));

  expect(on).toContain("github_read");
  expect(on).toContain("git_write");
  expect(on).toContain("github_write");
});

test("git/GitHub tools are offered on scratch runs too (a fresh repo still commits)", () => {
  const on = names(toolsFor(false, { github: true }));

  expect(on).toContain("github_read");
  expect(on).toContain("git_write");
  expect(on).toContain("github_write");
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

test("pull_conventions is offered per build BACKEND, not per flag", () => {
  // Decoupled from TSFORGE_WEB on purpose: a boringstack build sets
  // offerConventions=true regardless of the web flag; a plain session leaves
  // it off. Web being on must NOT drag the conventions tool in.
  process.env.TSFORGE_WEB = "1";
  expect(names(toolsFor(false))).not.toContain("pull_conventions");
  expect(names(toolsFor(true))).not.toContain("pull_conventions");

  expect(names(toolsFor(false, {}, true))).toContain("pull_conventions");
  expect(names(toolsFor(true, {}, true))).toContain("pull_conventions");
});

test("check is offered per build BACKEND (offerCheck), not by any flag", () => {
  // WS-G: the callable structured gate. Off by default on every path (a plain
  // eval/scratch task has no authoritative injected gate → a callable gate would
  // answer vacuously). A build backend opts in via the 4th toolsFor arg. Web being
  // on must NOT drag it in.
  process.env.TSFORGE_WEB = "1";
  expect(names(toolsFor(false))).not.toContain("check");
  expect(names(toolsFor(true))).not.toContain("check");

  expect(names(toolsFor(false, {}, false, true))).toContain("check");
  expect(names(toolsFor(true, {}, false, true))).toContain("check");
});

test("ask_user is offered only via offerAskUser (the co-pilot opt-in), off by default", () => {
  // WS-C1: the raise-hand tool. Off on every path unless the interactive co-pilot opts
  // in — an autonomous eval/CI run must not be tempted to ask a question no one answers.
  process.env.TSFORGE_WEB = "1";
  expect(names(toolsFor(false))).not.toContain("ask_user");
  expect(names(toolsFor(true))).not.toContain("ask_user");

  expect(names(toolsFor(false, {}, false, false, true))).toContain("ask_user");
  expect(names(toolsFor(true, {}, false, false, true))).toContain("ask_user");
  // present_plan rides the same interactive opt-in (plan-mode filter is in offeredToolsFor).
  expect(names(toolsFor(false, {}, false, false, true))).toContain(
    "present_plan"
  );
});

test("task_* tools are offered only via offerTaskTools (activePlanId bound)", () => {
  expect(names(toolsFor(false))).not.toContain("task_list");
  expect(names(toolsFor(true))).not.toContain("task_complete");

  const offered = names(toolsFor(false, {}, false, false, false, [], true));

  expect(offered).toContain("task_list");
  expect(offered).toContain("task_focus");
  expect(offered).toContain("task_complete");
  expect(offered).toContain("task_uncomplete");
  expect(offered).toContain("task_add");
  expect(offered).toContain("task_update");
});

test("the script tool is on by default for scratch and existing code", () => {
  expect(names(toolsFor(true))).toContain("script");
  expect(names(toolsFor(false))).toContain("script");
});

test("TSFORGE_NO_SCRIPT=1 withholds the script tool (kill switch)", () => {
  process.env.TSFORGE_NO_SCRIPT = "1";

  expect(names(toolsFor(true))).not.toContain("script");
  expect(names(toolsFor(false))).not.toContain("script");
});
