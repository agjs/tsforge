import { test, expect, describe } from "bun:test";
import { renderMessage, userBubble, agentCardTop } from "../src/render";
import { displayWidth } from "../src/render/width";

const ESC = String.fromCharCode(27);

function stripAnsi(s: string): string {
  return s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

describe("renderMessage — hybrid bubbles", () => {
  test("a user message renders a full rounded bubble", () => {
    const out = stripAnsi(
      renderMessage(
        { role: "user", content: "hey there" },
        { color: false, columns: 80 }
      )
    );

    expect(out).toContain("╭─ you ");
    expect(out).toContain("│ hey there");
    expect(out).toContain("╯"); // bottom-right corner closes the bubble
  });

  test("an assistant message renders a left-accent card with a rail", () => {
    const out = stripAnsi(
      renderMessage(
        { role: "assistant", content: "line one\nline two" },
        { color: false, speaker: "some-model", columns: 80 }
      )
    );

    expect(out).toContain("╭ some-model"); // rounded top cap + model label
    expect(out).toContain("│ line one");
    expect(out).toContain("│ line two");
    expect(out).toContain("╰"); // bottom cap closes the card
  });

  test("system and tool messages render nothing", () => {
    expect(renderMessage({ role: "system", content: "x" })).toBe("");
    expect(renderMessage({ role: "tool", content: "x" })).toBe("");
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
});

describe("agentCardTop", () => {
  test("labels the card with a rounded cap + model name", () => {
    expect(stripAnsi(agentCardTop("qwen3", false))).toBe("╭ qwen3");
  });
});

describe("agent card replay wrapping (--continue path)", () => {
  test("a long replayed line wraps INSIDE the rail — every row keeps │ and fits", () => {
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
    // Drop the top/bottom caps; every BODY row must carry the rail and fit.
    const body = rows.filter((r) => r.startsWith("│"));

    expect(body.length).toBeGreaterThan(1); // it actually wrapped

    for (const row of body) {
      expect(displayWidth(row)).toBeLessThanOrEqual(columns);
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
