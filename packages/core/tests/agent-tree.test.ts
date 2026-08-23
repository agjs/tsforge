import { test, expect, describe } from "bun:test";
import {
  formatAgentSummary,
  makeAgentSummaryTracker,
  renderAgentTree,
  AgentTreeModel,
  type IAgentRow,
} from "../src/render/agent-tree";
import { displayWidth } from "../src/render/width";

describe("formatAgentSummary", () => {
  test("empty input renders nothing", () => {
    expect(formatAgentSummary([])).toBe("");
  });

  test("summarizes running/done/failed with running ids listed", () => {
    const line = formatAgentSummary([
      { id: "find:a.ts", status: "running" },
      { id: "find:b.ts", status: "running" },
      { id: "find:c.ts", status: "done" },
      { id: "find:d.ts", status: "failed" },
    ]);

    expect(line).toBe(
      "agents: 2 running, 1/4 done, 1 failed (find:a.ts · find:b.ts)"
    );
  });

  test("elides beyond three running ids with a +N tail", () => {
    const line = formatAgentSummary(
      Array.from({ length: 5 }, (_, i) => ({
        id: `find:f${String(i)}.ts`,
        status: "running" as const,
      }))
    );

    expect(line).toContain("5 running");
    expect(line).toContain("· +2)");
    expect(line).not.toContain("f4.ts");
  });

  test("all done → no running list", () => {
    expect(
      formatAgentSummary([
        { id: "a", status: "done" },
        { id: "b", status: "done" },
      ])
    ).toBe("agents: 2/2 done");
  });
});

describe("makeAgentSummaryTracker", () => {
  test("stable denominator: pendings announce the total before anything runs", () => {
    const lines: string[] = [];
    const track = makeAgentSummaryTracker((line) => lines.push(line));

    // Two units spawn up-front — the denominator is 2 from the first line.
    track({ kind: "agent_spawned", task: "review", message: "find:a.ts" });
    track({ kind: "agent_spawned", task: "review", message: "find:b.ts" });
    track({ kind: "cycle", task: "review", message: "" }); // not an agent event
    track({ kind: "agent_started", task: "review", message: "find:a.ts" });
    track({
      kind: "agent_result",
      task: "review",
      message: "find:a.ts",
      passed: true,
    });

    expect(lines).toEqual([
      "agents: 0/1 done",
      "agents: 0/2 done",
      "agents: 1 running, 0/2 done (find:a.ts)",
      "agents: 1/2 done",
    ]);
  });

  test("a failed result counts as failed, not done", () => {
    const lines: string[] = [];
    const track = makeAgentSummaryTracker((line) => lines.push(line));

    track({
      kind: "agent_spawned",
      task: "review",
      message: "verify:x.ts:3#0",
    });
    track({
      kind: "agent_started",
      task: "review",
      message: "verify:x.ts:3#0",
    });
    track({
      kind: "agent_result",
      task: "review",
      message: "verify:x.ts:3#0",
      passed: false,
    });

    expect(lines.at(-1)).toBe("agents: 0/1 done, 1 failed");
  });
});

describe("renderAgentTree", () => {
  const plain = { columns: 60, color: false };

  test("empty input renders nothing", () => {
    expect(renderAgentTree([], plain)).toEqual([]);
  });

  test("a single done row shows glyph, label, and meta", () => {
    const lines = renderAgentTree(
      [{ id: "explore", status: "done", durationMs: 1200, turns: 3 }],
      plain
    );

    expect(lines[0]).toBe("● agents · 1/1 done");
    expect(lines[1]).toBe("└─ ✓ explore · 1.2s · 3 turns");
  });

  test("status glyphs: pending ○, running spinner, done ✓, failed ✗", () => {
    const rows: IAgentRow[] = [
      { id: "a", status: "pending" },
      { id: "b", status: "running" },
      { id: "c", status: "done" },
      { id: "d", status: "failed" },
    ];
    const lines = renderAgentTree(rows, { ...plain, frame: 0 });

    expect(lines[0]).toBe("● agents · 1 running · 1/4 done · 1 failed");
    expect(lines[1]).toBe("├─ ○ a");
    expect(lines[2]).toBe("├─ ⠋ b"); // frame 0 spinner
    expect(lines[3]).toBe("├─ ✓ c");
    expect(lines[4]).toBe("└─ ✗ d"); // last row → end connector
  });

  test("running rows animate with the frame index", () => {
    const row: IAgentRow[] = [{ id: "x", status: "running" }];

    expect(renderAgentTree(row, { ...plain, frame: 1 })[1]).toBe("└─ ⠙ x");
    expect(renderAgentTree(row, { ...plain, frame: 2 })[1]).toBe("└─ ⠹ x");
  });

  test("negative/large frame indices stay in range (no crash, valid glyph)", () => {
    const row: IAgentRow[] = [{ id: "x", status: "running" }];

    expect(renderAgentTree(row, { ...plain, frame: -1 })[1]).toBe("└─ ⠏ x");
    expect(renderAgentTree(row, { ...plain, frame: 1000 })[1]).toBe("└─ ⠋ x");
  });

  test("overflow collapses the tail into a `… +N more` row", () => {
    const rows: IAgentRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `agent-${String(i)}`,
      status: "pending" as const,
    }));
    const lines = renderAgentTree(rows, { ...plain, maxRows: 4 });

    // header + (maxRows-1)=3 shown rows + 1 overflow line
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("● agents · 0/10 done"); // denominator = full total
    expect(lines.at(-1)).toBe("└─ … +7 more");
  });

  test("labels are clipped with … and no line exceeds columns-1", () => {
    const rows: IAgentRow[] = [
      {
        id: "a-very-long-agent-identifier-that-will-not-fit",
        status: "running",
      },
    ];
    const lines = renderAgentTree(rows, {
      columns: 20,
      color: false,
      frame: 0,
    });

    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(19);
    }

    expect(lines[1]).toContain("…");
  });

  test("a done row's meta drops (not half-prints) rather than overflow", () => {
    const rows: IAgentRow[] = [
      { id: "x", status: "done", durationMs: 1200, turns: 3 },
    ];
    const lines = renderAgentTree(rows, { columns: 12, color: false });

    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(11);
    }

    // The meta couldn't fit, so it's gone entirely — no ` · 1.2` fragment.
    expect(lines[1]).not.toContain("1.2");
  });

  test("every line stays ≤ columns-1 across ALL widths (no self-wrap, incl. very narrow)", () => {
    const rows: IAgentRow[] = [
      { id: "a", label: "explore loop subsystem", status: "running" },
      { id: "b", label: "verify", status: "done", durationMs: 900, turns: 2 },
    ];

    for (let cols = 1; cols <= 40; cols += 1) {
      const lines = renderAgentTree(rows, { columns: cols, color: false });

      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(cols - 1);
      }
    }
  });

  test("the overflow tail (`… +N more`) also stays ≤ columns-1 at narrow widths", () => {
    // Enough rows to overflow maxRows, at widths where the tree still renders —
    // the tail line must be clipped too, not just the agent rows.
    const rows: IAgentRow[] = Array.from({ length: 20 }, (_v, i) => ({
      id: `agent-${String(i)}`,
      status: "pending" as const,
    }));

    for (let cols = 8; cols <= 30; cols += 1) {
      const lines = renderAgentTree(rows, {
        columns: cols,
        color: false,
        maxRows: 4,
      });

      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(cols - 1);
      }
    }
  });

  test("below the minimum usable width, renders nothing (rather than a wrapping line)", () => {
    const rows: IAgentRow[] = [{ id: "a", label: "x", status: "running" }];

    for (const cols of [1, 2, 3, 5, 7]) {
      expect(renderAgentTree(rows, { columns: cols, color: false })).toEqual(
        []
      );
    }

    // At a usable width it renders again.
    expect(
      renderAgentTree(rows, { columns: 20, color: false }).length
    ).toBeGreaterThan(0);
  });

  test("honors the real width — no upward clamp that draws wider than the screen", () => {
    const rows: IAgentRow[] = [{ id: "explore", status: "pending" }];

    // A 10-col terminal must not produce a 19-col line (the old 20-clamp bug).
    for (const line of renderAgentTree(rows, { columns: 10, color: false })) {
      expect(displayWidth(line)).toBeLessThanOrEqual(9);
    }
  });

  test("selectedId marks exactly one row with the ▸ caret", () => {
    const rows: IAgentRow[] = [
      { id: "a", label: "explore", status: "running" },
      { id: "b", label: "verify", status: "running" },
    ];
    const lines = renderAgentTree(rows, {
      columns: 60,
      color: false,
      frame: 0,
      selectedId: "b",
    });

    // The unselected row keeps a plain gap; the selected row gets `▸ ` so
    // the caret is not jammed into the label (`▸verify`).
    expect(lines[1]?.includes("▸")).toBe(false);
    expect(lines[2]?.includes("▸ verify")).toBe(true);
    // Exactly one caret across the whole tree.
    expect(lines.filter((l) => l.includes("▸"))).toHaveLength(1);
  });
});

describe("AgentTreeModel", () => {
  test("applyUnit maps start→running and preserves spawn order", () => {
    const model = new AgentTreeModel();

    model.applyUnit("b", "pending");
    model.applyUnit("a", "pending");
    model.applyUnit("a", "start");

    const rows = model.rows();

    expect(rows.map((r) => r.id)).toEqual(["b", "a"]); // insertion order, not status
    expect(rows[0]?.status).toBe("pending");
    expect(rows[1]?.status).toBe("running");
  });

  test("done meta (duration/turns) is retained across later reads", () => {
    const model = new AgentTreeModel();

    model.applyUnit("x", "pending");
    model.applyUnit("x", "start");
    model.applyUnit("x", "done", { durationMs: 900, turns: 2 });

    const row = model.rows()[0];

    expect(row?.status).toBe("done");
    expect(row?.durationMs).toBe(900);
    expect(row?.turns).toBe(2);
  });

  test("applyEvent folds lifecycle events (passed=false → failed)", () => {
    const model = new AgentTreeModel();

    model.applyEvent({ kind: "agent_spawned", task: "t", message: "one" });
    model.applyEvent({ kind: "agent_started", task: "t", message: "one" });
    model.applyEvent({
      kind: "agent_result",
      task: "t",
      message: "one",
      passed: false,
    });

    expect(model.rows()[0]?.status).toBe("failed");
  });

  test("keys rows by agentId; agent_result payload in message doesn't spawn a row", () => {
    const model = new AgentTreeModel();

    model.applyEvent({
      kind: "agent_spawned",
      task: "t",
      agentId: "run-1:explore",
      message: "explore",
    });
    model.applyEvent({
      kind: "agent_started",
      task: "t",
      agentId: "run-1:explore",
      message: "explore",
    });
    // agent_result: message carries the final payload, NOT the id.
    model.applyEvent({
      kind: "agent_result",
      task: "t",
      agentId: "run-1:explore",
      message: "3 findings",
      passed: true,
    });

    const rows = model.rows();

    expect(rows).toHaveLength(1); // completed the running row, no bogus "3 findings"
    expect(rows[0]?.status).toBe("done");
    expect(rows[0]?.label).toBe("explore"); // spawn message kept as the label
  });
});
