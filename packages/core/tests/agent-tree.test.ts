import { test, expect, describe } from "bun:test";
import {
  formatAgentSummary,
  makeAgentSummaryTracker,
} from "../src/render/agent-tree";

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
