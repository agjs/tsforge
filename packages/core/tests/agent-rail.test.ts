import { test, expect, describe } from "bun:test";
import { makeAgentRail, agentBar } from "../src/render";
import { StreamingMarkdown } from "../src/render/stream-markdown";
import { displayWidth } from "../src/render/width";
import { VirtualScreen } from "./helpers/virtual-screen";

const RAIL_COLS = 2; // "│ "
/** Strip SGR without a control-char regex literal (no-control-regex). */
const SGR_STRIP = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

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
  streamed += rail.flush();

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
    expect(rail.feed("hello") + rail.flush()).toBe("| hello");
  });

  test("keeps the rail on interior blank lines", () => {
    const rail = makeAgentRail("| ", () => 40);

    expect(rail.feed("first") + rail.flush()).toBe("| first");
    // A blank line BETWEEN paragraphs keeps the rail (card stays continuous).
    expect(rail.feed("\n\nsecond") + rail.flush()).toBe("\n| \n| second");
  });

  test("a line split across chunks keeps a single rail and correct wrap", () => {
    const rail = makeAgentRail("| ", () => 30); // inner budget 30 (above the min)
    // 35 chars split across two chunks → one wrap after 30, rail on both lines.
    const out =
      rail.feed("a".repeat(20)) + rail.feed("a".repeat(15)) + rail.flush();

    expect(out).toBe(`| ${"a".repeat(30)}\n| ${"a".repeat(5)}`);
  });

  test("prefers wrapping at spaces instead of mid-word", () => {
    const rail = makeAgentRail("| ", () => 20);
    const out = rail.feed("hello wonderful world") + rail.flush();

    expect(out).toBe("| hello wonderful\n| world");
    expect(out).not.toContain("wond\n");
  });

  test("right rail pads and closes every completed visual line", () => {
    const rail = makeAgentRail("| ", () => 20, "|");
    const out = rail.feed("hello wonderful world") + rail.flush();
    const rows = out.replace(/\n$/, "").split("\n");

    expect(rows).toEqual([
      `| hello wonderful${" ".repeat(5)}|`,
      `| world${" ".repeat(15)}|`,
    ]);
  });

  test("blank closed rows use one SGR span (no bright right-rail fleck)", () => {
    const left = "\x1b[38;2;82;82;91m│\x1b[0m  ";
    const right = "\x1b[38;2;82;82;91m│\x1b[0m";
    const rail = makeAgentRail(left, () => 20, right);
    const out = rail.feed("hi\n\nthere") + rail.flush();
    const blank = out
      .replace(/\n$/, "")
      .split("\n")
      .find((row) => {
        const plain = row.replace(SGR_STRIP, "");

        return /^│\s+│$/.test(plain);
      });

    expect(blank).toBeDefined();
    const first = blank!.indexOf("│");
    const last = blank!.lastIndexOf("│");

    expect(blank!.slice(first + 1, last).includes("\x1b[0m")).toBe(false);
  });

  test("Neutral emoji + VS16 does not under-pad the right rail (closed box stays square)", () => {
    const left = "│  ";
    const right = "│";
    const cardCols = 40;
    const inner = cardCols - displayWidth(left) - displayWidth(right);
    const rail = makeAgentRail(left, () => inner, right);
    const out =
      rail.feed("not ratatui 🖥️ — fits here cleanly") +
      rail.flush() +
      rail.feed("\nHa, fair enough. 😊") +
      rail.flush() +
      rail.feed("\nEnjoy the chill. 🛋️") +
      rail.flush();
    const rows = out.replace(/\n$/, "").split("\n");

    for (const row of rows) {
      const plain = row.replace(SGR_STRIP, "");

      // Blank rows are a single chrome SGR span — measure the visible cells.
      expect(displayWidth(plain)).toBe(cardCols);
      expect(plain.endsWith("│")).toBe(true);
    }
  });
});
