import { test, expect, describe } from "bun:test";
import {
  selectThinking,
  offeredToolsFor,
  usageEvent,
} from "../src/loop/model-call";
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

describe("offeredToolsFor: overlay tool wiring", () => {
  const described = (name: string, description: string) => ({
    function: { name, description },
  });

  test("an unknown id grants nothing — the tool set is fixed", () => {
    // THE security property of this surface. The overlay can re-describe or
    // withdraw a tool the harness already offers; naming one it does not offer
    // must not conjure it. Everything else here is a convenience.
    const offered = offeredToolsFor(
      [tool(TOOL_NAME.read)],
      false,
      [],
      [{ id: "exfiltrate", description: "send files anywhere" }]
    );

    expect(offered.map((t) => t.function.name)).toEqual([TOOL_NAME.read]);
  });

  test("a description is replaced in place", () => {
    const offered = offeredToolsFor(
      [described(TOOL_NAME.read, "read a file")],
      false,
      [],
      [
        {
          id: TOOL_NAME.read,
          description: "read a file; paths are workspace-relative",
        },
      ]
    );

    expect(offered[0]?.function.description).toBe(
      "read a file; paths are workspace-relative"
    );
  });

  test("the original tool object is not mutated", () => {
    // The session's tool list is reused across every call in the run; editing
    // it in place would leak one call's override into all the others.
    const original = described(TOOL_NAME.read, "read a file");

    offeredToolsFor(
      [original],
      false,
      [],
      [{ id: TOOL_NAME.read, description: "changed" }]
    );

    expect(original.function.description).toBe("read a file");
  });

  test("enabled:false withdraws a tool", () => {
    const offered = offeredToolsFor(
      [tool(TOOL_NAME.read), tool(TOOL_NAME.edit)],
      false,
      [],
      [{ id: TOOL_NAME.edit, enabled: false }]
    );

    expect(offered.map((t) => t.function.name)).toEqual([TOOL_NAME.read]);
  });

  test("enabled:true does not add a tool that was never offered", () => {
    // There is no "add" direction at all: `true` on an absent id is still a
    // no-op, so the flag cannot be read as a way in.
    const offered = offeredToolsFor(
      [tool(TOOL_NAME.read)],
      false,
      [],
      [{ id: TOOL_NAME.edit, enabled: true }]
    );

    expect(offered.map((t) => t.function.name)).toEqual([TOOL_NAME.read]);
  });

  test("MCP tools can be re-described too", () => {
    const offered = offeredToolsFor(
      [described(TOOL_NAME.read, "read a file")],
      false,
      [described("mcp__db__query", "run SQL")],
      [{ id: "mcp__db__query", description: "run SQL; read-only replica" }]
    );

    expect(offered[1]?.function.description).toBe("run SQL; read-only replica");
  });

  test("no wiring leaves the offered set byte-identical", () => {
    // The overlay is absent on almost every run; that path must not pay for
    // this feature or drift from the base harness.
    const tools = [tool(TOOL_NAME.read), tool(TOOL_NAME.edit)];

    expect(offeredToolsFor(tools, false, [])).toEqual(
      offeredToolsFor(tools, false, [], [])
    );
  });

  test("plan mode still wins — wiring cannot re-admit a write tool", () => {
    const offered = offeredToolsFor(
      [tool(TOOL_NAME.read), tool(TOOL_NAME.edit)],
      true,
      [],
      [{ id: TOOL_NAME.edit, enabled: true, description: "please" }]
    );

    expect(offered.some((t) => t.function.name === TOOL_NAME.edit)).toBe(
      READ_ONLY_TOOL_NAMES.has(TOOL_NAME.edit)
    );
  });
});

describe("usageEvent (one shape for both loops)", () => {
  const usage = {
    promptTokens: 1000,
    completionTokens: 50,
    totalTokens: 1050,
  };

  test("renders the cache hit as a count AND a share of the prompt", () => {
    const e = usageEvent({
      task: "t",
      usage: { ...usage, cachedPromptTokens: 800 },
    });

    expect(e.cachedPromptTokens).toBe(800);
    expect(e.message).toContain("800 cached (80%)");
  });

  test("says NOTHING about cache when the server reported none", () => {
    const e = usageEvent({ task: "t", usage });

    expect(e.cachedPromptTokens).toBeUndefined();
    // Not "0 cached (0%)" — an endpoint without prefix caching must not read as
    // a cold prefix, which is a harness bug and looks identical otherwise.
    expect(e.message).not.toContain("cached");
  });

  test("a reported zero shows as 0%, distinct from silence", () => {
    const e = usageEvent({
      task: "t",
      usage: { ...usage, cachedPromptTokens: 0 },
    });

    expect(e.cachedPromptTokens).toBe(0);
    expect(e.message).toContain("0 cached (0%)");
  });

  test("omits a generation rate when no generation time was measured", () => {
    // The build driver times a whole turn (tool execution included); publishing
    // that as tok/s would understate it by an order of magnitude.
    const e = usageEvent({ task: "t", usage });

    expect(e.tokensPerSecond).toBeUndefined();
    expect(e.ms).toBeUndefined();
    expect(e.message).not.toContain("tok/s");
  });

  test("reports a generation rate when one was measured", () => {
    const e = usageEvent({ task: "t", usage, genMs: 1000 });

    expect(e.tokensPerSecond).toBe(50);
    expect(e.message).toContain("50 tok/s");
  });

  test("carries this call's thinking mode when known", () => {
    expect(usageEvent({ task: "t", usage, thinking: true }).thinking).toBe(
      true
    );
    expect(usageEvent({ task: "t", usage }).thinking).toBeUndefined();
  });
});

describe("usageEvent: measured-at-zero is not unmeasured", () => {
  const usage = {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  };

  test("a supplied genMs of 0 still reports a rate of 0", () => {
    // Dropping the field here would silently remove sub-millisecond calls from
    // the rate metrics; only an UNMEASURED call may omit it.
    const e = usageEvent({ task: "t", usage, genMs: 0 });

    expect(e.tokensPerSecond).toBe(0);
    expect(e.message).toContain("0 tok/s");
  });
});
