import { test, expect, describe } from "bun:test";
import {
  formatInputBox,
  formatInputBoxBottom,
  formatInputBoxMid,
  formatInputBoxTop,
  formatInputStatusLabel,
  INPUT_EDITOR_GUTTER,
  INPUT_PROMPT,
  inputContentCols,
  inputCursorCol,
} from "../src/render/frame/input-box";
import { stripSgr } from "../src/render/frame/ansi-plain";
import { displayWidth } from "../src/render/width";

describe("input box", () => {
  test("gutter reserves borders, pads, and prompt", () => {
    expect(INPUT_EDITOR_GUTTER).toBe(10);
    expect(inputContentCols(80)).toBe(70);
    expect(inputCursorCol(0)).toBe(1 + 3 + INPUT_PROMPT.length);
  });

  test("status label stays empty — top strip owns session chips", () => {
    expect(
      formatInputStatusLabel({
        model: "deepseek-chat",
        contextTokens: 0,
        contextWindow: 100,
        turns: 0,
        elapsedMs: 0,
        status: "ready",
        scope: "repo",
        mode: "plan",
      })
    ).toBe("");

    expect(formatInputStatusLabel(null)).toBe("");
  });

  test("top / mid / bottom are closed box rows of exact width", () => {
    const cols = 40;
    const top = stripSgr(formatInputBoxTop(cols, false));
    const mid = stripSgr(formatInputBoxMid(cols, "hi", false));
    const bottom = stripSgr(formatInputBoxBottom(cols, "", false));

    expect(top.startsWith("╭")).toBe(true);
    expect(top.endsWith("╮")).toBe(true);
    expect(displayWidth(top)).toBe(cols);

    expect(mid.startsWith("│")).toBe(true);
    expect(mid.endsWith("│")).toBe(true);
    expect(mid).toContain(`${INPUT_PROMPT}hi`);
    expect(displayWidth(mid)).toBe(cols);
    // Equal inner air: 3 spaces after left rail, ≥3 before right rail.
    expect(mid.startsWith("│   >")).toBe(true);
    expect(mid.endsWith("   │")).toBe(true);

    expect(bottom.startsWith("╰")).toBe(true);
    expect(bottom.endsWith("╯")).toBe(true);
    expect(displayWidth(bottom)).toBe(cols);
  });

  test("empty draft shows placeholder; caret sits after prompt", () => {
    const box = formatInputBox({
      cols: 36,
      draft: "",
      placeholder: "describe a task, or /help",
      color: false,
    });

    expect(box.lines).toHaveLength(3);
    expect(box.lines[1] ?? "").toContain("> ");
    expect(box.lines[1] ?? "").toContain("describe a task, or /help");
    expect(box.cursorCol).toBe(inputCursorCol(0));
  });

  test("multi-line draft grows the box; only the first mid row has >", () => {
    const box = formatInputBox({
      cols: 36,
      draftLines: ["hello", "world", "again"],
      color: false,
    });

    expect(box.lines).toHaveLength(5); // top + 3 mids + bottom
    expect(stripSgr(box.lines[1] ?? "")).toContain("> hello");
    expect(stripSgr(box.lines[2] ?? "")).toContain("world");
    expect(stripSgr(box.lines[2] ?? "")).not.toContain("> world");
    expect(stripSgr(box.lines[0] ?? "").startsWith("╭")).toBe(true);
    expect(stripSgr(box.lines[4] ?? "").startsWith("╰")).toBe(true);
  });
});
