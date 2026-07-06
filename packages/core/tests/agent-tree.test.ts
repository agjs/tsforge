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
  test("folds agent events into refreshed summary lines, ignores other kinds", () => {
    const lines: string[] = [];
    const track = makeAgentSummaryTracker((line) => lines.push(line));

    track({
      kind: "agent_spawned",
      task: "review",
      message: "find:a.ts",
      agentId: "review:find:a.ts",
      parentTask: "review",
    });
    track({ kind: "cycle", task: "review", message: "" }); // not an agent event
    track({
      kind: "agent_result",
      task: "review",
      message: "find:a.ts",
      agentId: "review:find:a.ts",
      parentTask: "review",
      passed: true,
    });

    expect(lines).toEqual([
      "agents: 1 running, 0/1 done (find:a.ts)",
      "agents: 1/1 done",
    ]);
  });

  test("a failed result counts as failed, not done", () => {
    const lines: string[] = [];
    const track = makeAgentSummaryTracker((line) => lines.push(line));

    track({
      kind: "agent_spawned",
      task: "review",
      message: "verify:x.ts:3",
    });
    track({
      kind: "agent_result",
      task: "review",
      message: "verify:x.ts:3",
      passed: false,
    });

    expect(lines.at(-1)).toBe("agents: 0/1 done, 1 failed");
  });
});
