import { test, expect, describe } from "bun:test";
import {
  StatusBar,
  buildBarFrame,
  type IStatusInfo,
  type IStatusBarTerminal,
} from "../src/render";

const INFO: IStatusInfo = {
  model: "qwen3.6-27b",
  contextTokens: 8000,
  contextWindow: 32000,
  turns: 2,
  elapsedMs: 12000,
  status: "done",
  scope: "src/**",
  tokensPerSecond: 48,
};

class FakeTerm implements IStatusBarTerminal {
  readonly writes: string[] = [];

  constructor(
    readonly isTTY: boolean,
    readonly rows: number,
    readonly columns: number
  ) {}

  write(data: string): boolean {
    this.writes.push(data);

    return true;
  }

  text(): string {
    return this.writes.join("");
  }
}

describe("buildBarFrame", () => {
  test("targets the bottom row, clears it, and preserves the cursor", () => {
    const frame = buildBarFrame(INFO, 80, 24, false);

    expect(frame.startsWith("\x1b7")).toBe(true); // save cursor
    expect(frame.endsWith("\x1b8")).toBe(true); // restore cursor
    expect(frame).toContain("\x1b[23;1H"); // border row (rows-1)
    expect(frame).toContain("\x1b[24;1H"); // segments row (rows)
    expect(frame).toContain("\x1b[2K"); // clear the line
    expect(frame).toContain("╶"); // top border tick
    expect(frame).toContain("qwen3.6-27b");
    expect(frame).toContain("48 tok/s");
    expect(frame).toContain("done");
  });

  test("drops segments that don't fit the width", () => {
    // Narrow: later segments (scope) are dropped rather than cut mid-escape.
    expect(buildBarFrame(INFO, 16, 24, false)).not.toContain("src/**");
    // Wide: the full set is shown.
    expect(buildBarFrame(INFO, 200, 24, false)).toContain("src/**");
  });

  // WS4: the spinner activity rides IN the bar (not on the readline input line,
  // which it used to erase). When present it renders; between turns it's absent.
  test("renders the live activity indicator when present", () => {
    const frame = buildBarFrame(
      { ...INFO, activity: "⠋ thinking · 12s" },
      200,
      24,
      false
    );

    expect(frame).toContain("⠋ thinking · 12s");
  });

  test("omits the activity segment between turns (no activity)", () => {
    expect(buildBarFrame(INFO, 200, 24, false)).not.toContain("thinking");
  });
});

describe("StatusBar activation", () => {
  test("stays inactive on a non-TTY and writes nothing", () => {
    const term = new FakeTerm(false, 24, 80);
    const bar = new StatusBar(term);

    bar.install(INFO);

    expect(bar.active).toBe(false);
    expect(term.writes).toHaveLength(0);
  });

  test("stays inactive on a tiny terminal", () => {
    const bar = new StatusBar(new FakeTerm(true, 3, 80));

    bar.install(INFO);

    expect(bar.active).toBe(false);
  });

  test("stays inactive when disabled", () => {
    const bar = new StatusBar(new FakeTerm(true, 24, 80), false);

    bar.install(INFO);

    expect(bar.active).toBe(false);
  });

  test("activates on a real terminal and reserves a scroll region", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = new StatusBar(term, true, false);

    bar.install(INFO);

    expect(bar.active).toBe(true);
    expect(term.text()).toContain("\x1b[1;22r"); // reserve bottom 2 rows (rows-2)
    expect(term.text()).toContain("\x1b[24;1H"); // segments drawn on row 24
  });

  test("teardown resets the scroll region and deactivates", () => {
    const term = new FakeTerm(true, 24, 80);
    const bar = new StatusBar(term, true, false);

    bar.install(INFO);
    term.writes.length = 0;
    bar.teardown();

    expect(bar.active).toBe(false);
    expect(term.text()).toContain("\x1b[r"); // reset scroll region
    expect(term.text()).toContain("\x1b[?25h"); // show cursor
  });

  test("update and teardown are no-ops while inactive", () => {
    const term = new FakeTerm(false, 24, 80);
    const bar = new StatusBar(term);

    bar.update(INFO);
    bar.teardown();

    expect(term.writes).toHaveLength(0);
  });
});
