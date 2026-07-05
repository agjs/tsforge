import { test, expect, describe } from "bun:test";
import { selectThinking, offeredToolsFor } from "../src/loop/model-call";
import { READ_ONLY_TOOL_NAMES, TOOL_NAME } from "../src/agent";

/** The pure per-call decisions extracted from Session.askModel (B2): the
 *  plan-mode read-only tool filter (a security property) and the adaptive
 *  thinking mode. These pin the exact precedence rules. */

describe("selectThinking", () => {
  test("a forced tool turn ALWAYS thinks-off, even while repairing", () => {
    expect(
      selectThinking({
        forceNoThinking: true,
        repairing: true,
        activeThinking: true,
        configured: true,
      })
    ).toBe(false);
  });

  test("repairing thinks, regardless of the configured/per-send setting", () => {
    expect(
      selectThinking({
        forceNoThinking: false,
        repairing: true,
        activeThinking: false,
        configured: false,
      })
    ).toBe(true);
  });

  test("otherwise the per-send override beats the config", () => {
    expect(
      selectThinking({
        forceNoThinking: false,
        repairing: false,
        activeThinking: true,
        configured: false,
      })
    ).toBe(true);
  });

  test("with no override, the config applies — incl. undefined passthrough", () => {
    expect(
      selectThinking({
        forceNoThinking: false,
        repairing: false,
        activeThinking: undefined,
        configured: false,
      })
    ).toBe(false);
    expect(
      selectThinking({
        forceNoThinking: false,
        repairing: false,
        activeThinking: undefined,
        configured: undefined,
      })
    ).toBeUndefined();
  });
});

function tool(name: string): { function: { name: string } } {
  return { function: { name } };
}

describe("offeredToolsFor (plan mode's read-only guarantee)", () => {
  // A genuinely read-only tool name from the registry, so the test breaks if
  // the derived set ever stops containing it.
  const readOnlyName = [...READ_ONLY_TOOL_NAMES][0] ?? "read";
  const tools = [
    tool(readOnlyName),
    tool(TOOL_NAME.create),
    tool(TOOL_NAME.run),
  ];

  test("plan mode filters out write tools; read-only + run survive", () => {
    const offered = offeredToolsFor(tools, true, []);
    const names = offered.map((t) => t.function.name);

    expect(names).toContain(readOnlyName);
    expect(names).toContain(TOOL_NAME.run);
    expect(names).not.toContain(TOOL_NAME.create);
  });

  test("normal mode advertises everything", () => {
    expect(offeredToolsFor(tools, false, [])).toHaveLength(tools.length);
  });

  test("MCP schemas ride along even in plan mode (external context sources)", () => {
    const mcp = [tool("mcp__docs__search")];
    const names = offeredToolsFor(tools, true, mcp).map((t) => t.function.name);

    expect(names).toContain("mcp__docs__search");
    expect(names).not.toContain(TOOL_NAME.create);
  });
});
