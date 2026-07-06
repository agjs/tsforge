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
});
