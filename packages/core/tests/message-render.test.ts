import { test, expect, describe } from "bun:test";
import {
  renderMessage,
  userBubble,
  agentCardTop,
  agentCardBottom,
  agentCardPadRow,
  agentCardRow,
  roleCardCols,
} from "../src/render";
import { STYLE } from "../src/render/style";
import { planHint } from "../src/cli/banner";
import { displayWidth } from "../src/render/width";

const ESC = String.fromCharCode(27);

function stripAnsi(s: string): string {
  return s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

describe("renderMessage — hybrid bubbles", () => {
  test("a user message renders a closed USER card (AGENT twin, cyan)", () => {
    const out = stripAnsi(
      renderMessage(
        { role: "user", content: "hey there" },
        { color: false, columns: 80 }
      )
    );

    expect(out).toContain(" USER ");
    expect(out).toContain("┐");
    expect(out).toContain("└");
    expect(out).toContain("┘");
    expect(out).toMatch(/│ {2}hey there\s+│/);
    expect(out).not.toContain("▌");
    expect(out).not.toContain("╭");
    expect(out).not.toContain("╰");
  });

  test("an assistant message renders a closed AGENT card", () => {
    const out = stripAnsi(
      renderMessage(
        { role: "assistant", content: "line one\nline two" },
        { color: false, speaker: "some-model", columns: 80 }
      )
    );

    expect(out).toContain(" AGENT ");
    expect(out).toContain("┐");
    expect(out).toContain("└");
    expect(out).toContain("┘");
    expect(out).not.toContain("some-model");
    expect(out).toMatch(/│ {2}line one\s+│/);
    expect(out).toMatch(/│ {2}line two\s+│/);
    expect(out).not.toContain("╭");
    expect(out).not.toContain("╰");
  });

  test("system and tool messages render nothing", () => {
    expect(renderMessage({ role: "system", content: "x" })).toBe("");
    expect(renderMessage({ role: "tool", content: "x" })).toBe("");
  });

  test("harness gate injects paint as AGENT cards, not USER", () => {
    const out = stripAnsi(
      renderMessage(
        {
          role: "user",
          content:
            "⚠ NEAR-GREEN — only 1 error(s) from done.\n\n" +
            "The acceptance command still fails:\n- SyntaxError\n\n" +
            "Fix your editable files and run it again.",
        },
        { color: false, columns: 80 }
      )
    );

    expect(out).toContain(" AGENT ");
    expect(out).toContain("NEAR-GREEN");
    expect(out).toContain("acceptance command still fails");
    expect(out).not.toContain(" USER ");
  });

  test("checklist injects stay out of the transcript", () => {
    expect(
      renderMessage({
        role: "user",
        content: "[checklist — session plan abc]\ngoal: x",
      })
    ).toBe("");
  });

  test("cards honor columns — resume must pass pane mainInnerCols, not stdout", () => {
    const narrow = 40;
    const wide = 120;
    const userNarrow = stripAnsi(
      renderMessage(
        { role: "user", content: "hey" },
        { color: false, columns: narrow }
      )
    );
    const userWide = stripAnsi(
      renderMessage(
        { role: "user", content: "hey" },
        { color: false, columns: wide }
      )
    );
    const topNarrow = userNarrow.split("\n").find((l) => l.includes("USER"));
    const topWide = userWide.split("\n").find((l) => l.includes("USER"));

    expect(topNarrow).toBeDefined();
    expect(topWide).toBeDefined();
    expect(displayWidth(topNarrow ?? "")).toBe(roleCardCols(narrow));
    expect(displayWidth(topWide ?? "")).toBe(roleCardCols(wide));
    expect(displayWidth(topNarrow ?? "")).toBeLessThan(
      displayWidth(topWide ?? "")
    );
  });
});

describe("role card alignment", () => {
  test("USER / AGENT / PLAN hug their labels and share the card right edge", () => {
    const cols = 40;
    const userTop =
      stripAnsi(userBubble("hi", false, cols)).split("\n")[0] ?? "";
    const agentTop = stripAnsi(agentCardTop(false, cols));
    const planTop = stripAnsi(planHint(false, cols)).split("\n")[0] ?? "";
    const agentBottom = stripAnsi(agentCardBottom(false, cols));
    const agentRow = stripAnsi(agentCardRow("hi", false, cols));

    expect(userTop.startsWith(" USER ")).toBe(true);
    expect(agentTop.startsWith(" AGENT ")).toBe(true);
    expect(planTop.startsWith(" PLAN ")).toBe(true);
    // No fixed-width right pad on shorter labels.
    expect(userTop.startsWith(" USER  ")).toBe(false);
    expect(planTop.startsWith(" PLAN  ")).toBe(false);

    expect(displayWidth(userTop)).toBe(cols);
    expect(displayWidth(agentTop)).toBe(cols);
    expect(displayWidth(planTop)).toBe(cols);
    expect(displayWidth(agentBottom)).toBe(cols);
    expect(displayWidth(agentRow)).toBe(cols);

    expect(userTop.endsWith("┐")).toBe(true);
    expect(agentTop.endsWith("┐")).toBe(true);
    expect(agentBottom.endsWith("┘")).toBe(true);
    expect(agentRow.endsWith("│")).toBe(true);

    const userBottom =
      stripAnsi(userBubble("hi", false, cols))
        .split("\n")
        .at(-1) ?? "";

    expect(userBottom.startsWith("└")).toBe(true);
    expect(userBottom.endsWith("┘")).toBe(true);
    expect(displayWidth(userBottom)).toBe(cols);
  });

  test("roleCardCols floors at the badge+cap minimum", () => {
    expect(roleCardCols(1)).toBeGreaterThanOrEqual(9);
  });
});

describe("userBubble", () => {
  test("wraps long content so no row exceeds the terminal width", () => {
    const long =
      "add a dark mode toggle to the settings page and persist the choice to " +
      "localStorage so it survives a full page reload every single time";
    const columns = 40;

    for (const row of stripAnsi(userBubble(long, false, columns)).split("\n")) {
      expect(displayWidth(row)).toBeLessThanOrEqual(columns);
    }
  });

  test("outlined badge and rails use cyan foreground (no fill) when color is on", () => {
    const out = userBubble("hi", true, 40);

    expect(out).toContain("[38;2;34;211;238m");
    expect(out).not.toContain("[48;2;34;211;238m");
    expect(out).not.toContain("[48;2;");
    expect(stripAnsi(out)).toMatch(/│ {2}hi\s+│/);
    expect(stripAnsi(out)).not.toContain("▌");
  });

  test("closed card: pad row under hairline, body, pad, bottom", () => {
    const rows = stripAnsi(userBubble("hi", false, 40)).split("\n");

    expect(rows[0]?.startsWith(" USER ")).toBe(true);
    expect(rows[0]?.endsWith("┐")).toBe(true);
    expect(rows[1]?.startsWith("│")).toBe(true);
    expect(rows[1]?.endsWith("│")).toBe(true);
    expect(/^│\s+│$/.test(rows[1] ?? "")).toBe(true);
    expect(rows[2]).toMatch(/│ {2}hi\s+│/);
    expect(rows.at(-1)?.startsWith("└")).toBe(true);
    expect(rows.at(-1)?.endsWith("┘")).toBe(true);
  });

  test("soft-wrapped body rows keep cyan on every visual line", () => {
    const long =
      "Essentially the entire app has to be built end-to-end with TDD tests " +
      "first. Of course our harness has a gate and it will guide you through " +
      "everything. Note that you are building a full-fledged app.";
    const rows = userBubble(long, true, 48).split("\n");
    const bodyRows = rows.filter((row) => {
      const plain = stripAnsi(row);

      return (
        plain.startsWith("│") &&
        plain.endsWith("│") &&
        /\S/.test(plain.slice(1, -1))
      );
    });

    expect(bodyRows.length).toBeGreaterThan(1);

    for (const row of bodyRows) {
      const plain = stripAnsi(row);

      // One SGR span for the whole closed row — no mid-line RESET that drops
      // continuation text to the default (gray) foreground after soft-wrap.
      expect(row).toBe(`${STYLE.cyan}${STYLE.bold}${plain}${ESC}[0m`);
    }
  });
});

describe("agentCardPadRow", () => {
  test("empty pad keeps both rails in one SGR span (no mid-line RESET)", () => {
    const row = agentCardPadRow(true, 40);
    const first = row.indexOf("│");
    const last = row.lastIndexOf("│");
    const between = row.slice(first + 1, last);

    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    // A RESET between the rails was the iTerm bright-fleck bug on empty rows.
    expect(between.includes("\x1b[0m")).toBe(false);
    expect(row).toContain("[38;2;82;82;91m");
    expect(displayWidth(stripAnsi(row))).toBe(40);
  });
});

describe("agentCardTop", () => {
  test("labels the card with an outlined AGENT badge + closed top rule", () => {
    const out = stripAnsi(agentCardTop(false, 40));

    expect(out.startsWith(" AGENT ")).toBe(true);
    expect(out).toContain("┐");
    expect(out).not.toContain("│");
    expect(displayWidth(out)).toBe(40);
  });

  test("outlined AGENT badge uses light chrome foreground (no fill) when color is on", () => {
    const out = agentCardTop(true, 40);

    expect(out).toContain("[38;2;244;244;245m");
    expect(out).not.toContain("[48;2;244;244;245m");
    expect(stripAnsi(out)).toContain(" AGENT ");
  });
});

describe("agent card replay wrapping (--continue path)", () => {
  test("a long replayed line wraps INSIDE the rails — every row keeps │ and fits", () => {
    const columns = 40;
    const long =
      "The quick brown fox jumps over the lazy dog again and again and " +
      "again until the line is far wider than the terminal.";
    const out = stripAnsi(
      renderMessage(
        { role: "assistant", content: long },
        { color: false, speaker: "m", columns }
      )
    );
    const rows = out.split("\n").filter((r) => r.length > 0);
    const body = rows.filter(
      (r) =>
        r.startsWith("│") &&
        r.endsWith("│") &&
        !r.includes(" AGENT ") &&
        !/^│\s+│$/.test(r)
    );

    expect(body.length).toBeGreaterThan(1);

    for (const row of body) {
      expect(displayWidth(row)).toBeLessThanOrEqual(columns);
      expect(row.endsWith("│")).toBe(true);
    }
  });

  test("wide chars count as 2 columns when wrapping the replay", () => {
    const columns = 24;
    const out = stripAnsi(
      renderMessage(
        { role: "assistant", content: "汉字汉字汉字汉字汉字汉字汉字汉字" },
        { color: false, speaker: "m", columns }
      )
    );

    for (const row of out.split("\n").filter((r) => r.startsWith("│"))) {
      expect(displayWidth(row)).toBeLessThanOrEqual(columns);
    }
  });
});
