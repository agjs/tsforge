import { test, expect, describe } from "bun:test";
import {
  CONSOLE,
  formatHints,
  formatTopStatus,
  formatConsoleTopbar,
  formatConsoleTitle,
  formatRailHeader,
  formatRailTitleBlock,
  hairline,
  insetX,
  CHROME_PAD_X,
  CHROME_PAD_Y,
  RAIL_TITLE_ROWS,
} from "../src/render/frame/chrome";
import { STYLE } from "../src/render/style";
import { stripSgr } from "../src/render/frame/ansi-plain";

describe("formatConsoleTitle", () => {
  test("mode chip: plan is amber outline, normal is light chrome outline", () => {
    const plan = formatConsoleTitle({
      info: {
        model: "m",
        contextTokens: 0,
        contextWindow: 100,
        turns: 0,
        elapsedMs: 0,
        status: "ready",
        scope: "repo",
        mode: "plan",
      },
      cwd: "/tmp",
      cols: 80,
      color: true,
    });
    const normal = formatConsoleTitle({
      info: {
        model: "m",
        contextTokens: 0,
        contextWindow: 100,
        turns: 0,
        elapsedMs: 0,
        status: "ready",
        scope: "repo",
        mode: "normal",
      },
      cwd: "/tmp",
      cols: 80,
      color: true,
    });

    expect(plan).toContain(" PLAN ");
    expect(plan).toContain(STYLE.plan);
    expect(plan).not.toContain("[48;2;");
    expect(normal).toContain(" NORMAL ");
    expect(normal).toContain(STYLE.chromeLight);
    expect(normal).not.toContain("[48;2;");
    expect(plan).not.toContain("◆");
    expect(normal).not.toContain("◆");
  });

  test("dense strip: brand+path+scope left, live chips right", () => {
    const row = formatConsoleTitle({
      info: {
        model: "deepseek",
        contextTokens: 40,
        contextWindow: 100,
        turns: 0,
        elapsedMs: 0,
        status: "ready",
        scope: "repo",
        mode: "plan",
        tokensPerSecond: 42,
      },
      cwd: "/tmp/demo",
      worklistBadge: "2/5",
      cols: 100,
      color: false,
    });

    expect(row).toContain("TSFORGE");
    expect(row).not.toContain("agent console");
    expect(row).toContain("/tmp/demo");
    expect(row).toContain("repo");
    expect(row).toContain("deepseek");
    expect(row).toContain("40%");
    expect(row).toContain("PLAN");
    expect(row).not.toContain("◆");
    expect(row).toContain("✓");
    expect(row).toContain("42t");
    expect(row).not.toContain("#2/5");
    // Where (brand…scope) then live chips — path before model.
    expect(row.indexOf("/tmp/demo")).toBeLessThan(row.indexOf("deepseek"));
    expect(row.indexOf("repo")).toBeLessThan(row.indexOf("deepseek"));
  });
});

describe("formatConsoleTopbar", () => {
  test("one-row air above title, tight air below, then hairline", () => {
    const lines = formatConsoleTopbar({
      info: {
        model: "deepseek",
        contextTokens: 40,
        contextWindow: 100,
        turns: 0,
        elapsedMs: 0,
        status: "ready",
        scope: "repo",
        mode: "plan",
      },
      cwd: "/tmp/demo",
      cols: 80,
      color: false,
      splitCol: 40,
    });

    expect(lines.length).toBe(CHROME_PAD_Y + 3);
    expect(lines.slice(0, CHROME_PAD_Y).every((l) => l.trim() === "")).toBe(
      true
    );
    const title = lines[CHROME_PAD_Y] ?? "";
    const padBottom = lines[CHROME_PAD_Y + 1] ?? "";
    const rule = lines[CHROME_PAD_Y + 2] ?? "";

    expect(padBottom.trim()).toBe("");
    expect(title).toContain("TSFORGE");
    expect(title.startsWith(" ".repeat(CHROME_PAD_X))).toBe(true);
    expect(rule).toContain("┬");
    expect(rule.replace(/┬/g, "─")).toMatch(/^─+$/);
    // Hairline continues through the panel column (right of ┬).
    const split = rule.indexOf("┬");

    expect(split).toBe(40);
    expect(rule.slice(split + 1)).toMatch(/^─+$/);
  });
});

describe("formatRailHeader", () => {
  test("Tasks left, bright done/total right, bordered title block", () => {
    const header = formatRailHeader({
      done: 2,
      total: 6,
      cols: 28,
      color: true,
    });
    const plain = stripSgr(header);
    const block = formatRailTitleBlock({
      done: 2,
      total: 6,
      cols: 28,
      color: false,
    });

    expect(plain).toContain("Tasks");
    expect(plain).toContain("2/6");
    expect(plain.indexOf("Tasks")).toBeLessThan(plain.indexOf("2/6"));
    expect(header).toContain(CONSOLE.bright);
    expect(header).not.toContain(STYLE.cyan);
    expect(RAIL_TITLE_ROWS).toBe(2);
    expect(block).toHaveLength(2);
    expect(block[0]).toContain("Tasks");
    expect(block[1]).toMatch(/^─+$/);
  });

  test("empty counts stay muted 0/0", () => {
    const header = formatRailHeader({
      done: 0,
      total: 0,
      cols: 28,
      color: true,
    });

    expect(stripSgr(header)).toContain("0/0");
    expect(header).not.toContain(CONSOLE.bright);
    expect(header).not.toContain(STYLE.cyan);
  });
});

describe("hairline", () => {
  test("inserts junction glyphs at the split", () => {
    const rule = hairline(10, "─", {
      splitCol: 4,
      junction: "┬",
      color: false,
    });

    expect(rule).toBe("────┬─────");
    expect(hairline(8, "─", { splitCol: 3, junction: "┴", color: false })).toBe(
      "───┴────"
    );
  });
});

describe("insetX", () => {
  test("keeps hairline-width content off the edges", () => {
    const line = insetX("hi", 12, 3);

    expect(line.startsWith("   ")).toBe(true);
    expect(line.endsWith("   ")).toBe(true);
    expect(line.length).toBe(12);
    expect(CHROME_PAD_X).toBe(3);
  });

  test("hard-clamps oversized content so pane gutters cannot be overwritten", () => {
    const line = insetX("x".repeat(200) + " overflow", 20, 3);

    expect(line.length).toBe(20);
    expect(line.startsWith("   ")).toBe(true);
    expect(line.endsWith("   ")).toBe(true);
    expect(line).not.toContain("overflow");
  });
});

describe("formatTopStatus", () => {
  test("delegates to the dense title strip", () => {
    const line = formatTopStatus({
      info: {
        model: "deepseek",
        contextTokens: 1,
        contextWindow: 100,
        turns: 0,
        elapsedMs: 0,
        status: "ready",
        scope: "repo",
        mode: "plan",
      },
      worklistBadge: "2/5",
      cols: 80,
      color: false,
    });

    expect(line).toContain("deepseek");
    expect(line).toContain("PLAN");
    expect(line).not.toContain("#2/5");
  });

  test("truncates when cols are tight", () => {
    const line = formatTopStatus({
      info: {
        model: "very-long-model-name-here",
        contextTokens: 1,
        contextWindow: 100,
        turns: 0,
        elapsedMs: 0,
        status: "ready",
        scope: "repo",
        mode: "plan",
        activity: "thinking",
      },
      worklistBadge: "9/9",
      cols: 20,
      color: false,
    });

    expect(line.length).toBeLessThanOrEqual(20);
  });
});

describe("formatHints", () => {
  test("changes with focus surface", () => {
    expect(formatHints("prompt", false)).toContain("Ctrl+G");
    expect(formatHints("panel", false)).toContain("Esc prompt");
    expect(formatHints("scrollback", false)).toContain("scroll");
    expect(formatHints("prompt", true)).toContain("abort");
    expect(formatHints("prompt", true)).toContain("Ctrl+G");
    expect(formatHints("prompt", true)).toContain("scroll");
  });
});
