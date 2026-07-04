import { test, expect, describe } from "bun:test";
import { makeAgentRail, agentBar } from "../src/render";
import { StreamingMarkdown } from "../src/render/stream-markdown";
import { displayWidth } from "../src/render/width";
import { VirtualScreen } from "./helpers/virtual-screen";

const RAIL_COLS = 2; // "│ "

/** Feed a paragraph through the streaming markdown renderer token-by-token (as the
 *  live loop does), then through the rail wrapper, and replay onto a screen. */
function railedRows(paragraph: string, cols: number): string[] {
  const rail = makeAgentRail(agentBar(true), () => cols - RAIL_COLS - 2);
  const md = new StreamingMarkdown();
  let streamed = "\n"; // the card top emits a leading "\n" before the first chunk

  for (const word of paragraph.split(/(\s+)/)) {
    streamed += rail.feed(md.push(word, true));
  }

  streamed += rail.feed(md.flush(true));

  const screen = new VirtualScreen(24, cols);

  screen.feed(`\x1b[H\x1b[2J${streamed.replace(/\n/g, "\r\n")}`);

  const rows: string[] = [];

  for (let i = 1; i <= 24; i += 1) {
    const row = screen.row(i).replace(/\s+$/, "");

    if (row.length > 0) {
      rows.push(row);
    }
  }

  return rows;
}

describe("makeAgentRail — the card's left rail never breaks", () => {
  const long =
    "Doing well! Running inside a harness you built, chatting with its " +
    "creator, getting to read some solid TypeScript code — pretty good gig " +
    "for an AI. 👍 wide chars 中文字符 here too.\n";

  for (const cols of [80, 92, 120]) {
    test(`every wrapped row keeps the rail and fits @${cols} cols`, () => {
      const rows = railedRows(long, cols);

      expect(rows.length).toBeGreaterThan(1); // it actually wrapped

      for (const row of rows) {
        // Every visual row starts with the rail — text never spills to column 0.
        expect(row.startsWith("│")).toBe(true);
        // No row fills the last column, so the terminal never wraps it itself.
        expect(displayWidth(row)).toBeLessThanOrEqual(cols - 1);
      }
    });
  }
});

describe("makeAgentRail — streaming semantics", () => {
  test("swallows the leading blank line (no gap under the card cap)", () => {
    const rail = makeAgentRail("| ", () => 40);

    // The card top emits "\n" first; the first content must NOT be preceded by a
    // blank rail line.
    expect(rail.feed("\n")).toBe("");
    expect(rail.feed("hello")).toBe("| hello");
  });

  test("keeps the rail on interior blank lines", () => {
    const rail = makeAgentRail("| ", () => 40);

    rail.feed("first");
    // A blank line BETWEEN paragraphs keeps the rail (card stays continuous).
    expect(rail.feed("\n\nsecond")).toBe("\n| \n| second");
  });

  test("a line split across chunks keeps a single rail and correct wrap", () => {
    const rail = makeAgentRail("| ", () => 30); // inner budget 30 (above the min)
    // 35 chars split across two chunks → one wrap after 30, rail on both lines.
    const out = rail.feed("a".repeat(20)) + rail.feed("a".repeat(15));

    expect(out).toBe(`| ${"a".repeat(30)}\n| ${"a".repeat(5)}`);
  });
});
