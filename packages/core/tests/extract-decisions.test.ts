import { test, expect, describe } from "bun:test";

import {
  parseExtractedDecisions,
  capExtractText,
  lastAssistantContent,
  EXTRACT_USER_CAP,
} from "../src/loop/memory/extract-decisions";
import type { IChatMessage } from "../src/inference/inference.types";

describe("parseExtractedDecisions", () => {
  test("returns empty for NONE / empty / []", () => {
    expect(parseExtractedDecisions("")).toEqual([]);
    expect(parseExtractedDecisions("   ")).toEqual([]);
    expect(parseExtractedDecisions("NONE")).toEqual([]);
    expect(parseExtractedDecisions("none")).toEqual([]);
    expect(parseExtractedDecisions("[]")).toEqual([]);
    expect(parseExtractedDecisions("No durable decisions")).toEqual([]);
  });

  test("empty JSON from a well-behaved model on junk turns yields nothing", () => {
    // Semantic filtering of plan-approval / harness chatter is the extract
    // SYSTEM prompt's job; the parser's contract is: NONE / [] → no retains.
    expect(
      parseExtractedDecisions("No durable product decisions in this turn.\n[]")
    ).toEqual([]);
  });

  test("parses a JSON array of architecture decisions", () => {
    const out = parseExtractedDecisions(
      'Here you go:\n["Company FK is a native <select>, not a combobox", "Prefer package-follow gates in workspace containers"]\n'
    );

    expect(out).toEqual([
      "Company FK is a native <select>, not a combobox",
      "Prefer package-follow gates in workspace containers",
    ]);
  });

  test("parses bullet lines when JSON is missing", () => {
    const out = parseExtractedDecisions(
      [
        "- Company FK is a native select, not a combobox",
        "- Prefer package-follow gates in workspace containers",
        "NONE",
      ].join("\n")
    );

    expect(out).toContain("Company FK is a native select, not a combobox");
    expect(out).toContain(
      "Prefer package-follow gates in workspace containers"
    );
    expect(out).not.toContain("NONE");
  });

  test("dedupes case-insensitively and caps at 5", () => {
    const items = [
      "Decision one about the data model rules",
      "DECISION ONE ABOUT THE DATA MODEL RULES",
      "Decision two about the UI patterns here",
      "Decision three about naming conventions",
      "Decision four about gate policy choice",
      "Decision five about stack selection now",
      "Decision six about something else entirely",
    ];
    const out = parseExtractedDecisions(JSON.stringify(items));

    expect(out).toHaveLength(5);
    expect(out[0]).toBe("Decision one about the data model rules");
    expect(out[4]).toBe("Decision five about stack selection now");
  });

  test("rejects tiny fragments", () => {
    expect(parseExtractedDecisions('["ok", "yes"]')).toEqual([]);
  });
});

describe("capExtractText", () => {
  test("caps long text with ellipsis", () => {
    const long = "a".repeat(EXTRACT_USER_CAP + 50);
    const capped = capExtractText(long, EXTRACT_USER_CAP);

    expect(capped.length).toBeLessThanOrEqual(EXTRACT_USER_CAP);
    expect(capped.endsWith("…")).toBe(true);
  });
});

describe("lastAssistantContent", () => {
  test("returns the latest non-empty assistant message", () => {
    const messages: IChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "older" },
      { role: "user", content: "again" },
      { role: "assistant", content: "  latest decision note  " },
      { role: "tool", content: "tool out", toolCallId: "1" },
    ];

    expect(lastAssistantContent(messages)).toBe("latest decision note");
  });

  test("returns empty when no assistant content", () => {
    expect(lastAssistantContent([{ role: "user", content: "only" }])).toBe("");
  });
});
