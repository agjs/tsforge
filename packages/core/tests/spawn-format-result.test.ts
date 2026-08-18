import { test, expect, describe } from "bun:test";
import { formatResult } from "../src/cli/spawn-runner";
import type { IAgentResult } from "../src/agent";

function result(
  status: IAgentResult["status"],
  outputKind: IAgentResult["outputKind"],
  output: string
): IAgentResult {
  return { status, output, outputKind, turns: 3, durationMs: 1, events: [] };
}

describe("formatResult — the tool-result text the orchestrator reads", () => {
  test("done is byte-identical to the pre-fix rendering", () => {
    expect(formatResult("research", result("done", "answer", "findings"))).toBe(
      "[research]\nfindings"
    );
  });

  test("cap-hit with an answer is labeled as usable partial findings", () => {
    expect(
      formatResult("research", result("max_turns", "answer", "partial stuff"))
    ).toBe("[research [max_turns — partial findings below]]\npartial stuff");
  });

  test("cap-hit without an answer is labeled as a transcript digest", () => {
    expect(
      formatResult("research", result("max_turns", "salvage", "digest"))
    ).toBe(
      "[research [max_turns — no final answer; transcript digest below]]\ndigest"
    );
  });

  test("aborted variants", () => {
    expect(formatResult("explore", result("aborted", "answer", "prose"))).toBe(
      "[explore [aborted — partial output below]]\nprose"
    );
    expect(
      formatResult("explore", result("aborted", "salvage", "digest"))
    ).toBe("[explore [aborted — transcript digest below]]\ndigest");
  });

  test("error keeps its plain tag; the output now carries the reason", () => {
    expect(
      formatResult("verify", result("error", "salvage", "boom 503\n\ndigest"))
    ).toBe("[verify [error]]\nboom 503\n\ndigest");
  });

  test("status word stays the first token inside the bracket (log tooling contract)", () => {
    const text = formatResult("research", result("max_turns", "answer", "x"));

    expect(text.startsWith("[research [max_turns")).toBe(true);
  });
});
