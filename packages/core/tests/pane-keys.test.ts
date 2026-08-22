import { test, expect, describe } from "bun:test";
import {
  handleFocusKey,
  handleScrollKey,
  handleMouseKey,
} from "../src/render/frame/pane-keys";
import { PaneFocus } from "../src/render/frame/focus";
import { Scrollback } from "../src/render/frame/scrollback";
import { resolveTuiKeybindings } from "../src/config/tui-keybindings";

function deps(overrides: { panelLen?: number; paints?: number[] } = {}) {
  const focus = new PaneFocus();
  const scrollback = new Scrollback(100, 5);
  const paints = overrides.paints ?? [];

  focus.syncHasItems((overrides.panelLen ?? 3) > 0);

  return {
    focus,
    scrollback,
    keybindings: resolveTuiKeybindings(),
    panelLen: overrides.panelLen ?? 3,
    paint: () => {
      paints.push(1);
    },
    invalidate: () => undefined,
    paints,
  };
}

describe("handleFocusKey", () => {
  test("Ctrl+G hides panel then shows it again", () => {
    const d = deps();

    expect(d.focus.panel).toBe("visibleUnfocused");
    expect(handleFocusKey("\x07", d)).toBe("handled");
    expect(d.focus.panel).toBe("hidden");
    expect(d.focus.userCollapsed).toBe(true);
    expect(d.paints.length).toBe(1);

    expect(handleFocusKey("\x07", d)).toBe("handled");
    expect(d.focus.panel).toBe("visibleFocused");
    expect(d.focus.panelFocused).toBe(true);
    expect(d.focus.userCollapsed).toBe(false);
  });

  test("Tab from prompt stays with the editor; Tab from panel returns to prompt", () => {
    const d = deps();

    expect(handleFocusKey("\t", d)).toBe("passthrough");
    d.focus.tab(true);
    expect(d.focus.panelFocused).toBe(true);
    expect(handleFocusKey("\t", d)).toBe("handled");
    expect(d.focus.promptFocused).toBe(true);
  });

  test("Esc from panel returns handled", () => {
    const d = deps();

    d.focus.tab(true);
    expect(handleFocusKey("\x1b", d)).toBe("handled");
    expect(d.focus.promptFocused).toBe(true);
  });

  test("Enter on gate row invokes onGateEnter only when panel+gate focused", () => {
    const d = {
      ...deps({ panelLen: 2 }),
      onGateEnter: () => true,
    };

    d.focus.railSurface = "gate";
    d.focus.tab(true);
    expect(handleFocusKey("\r", d)).toBe("handled");

    d.focus.railSurface = "tasks";
    expect(handleFocusKey("\r", d)).toBeNull();
  });

  test("cycle surface binding toggles railSurface and invalidates frame", () => {
    const bindings = resolveTuiKeybindings();
    let invalidated = 0;
    const d = {
      ...deps(),
      keybindings: bindings,
      refreshed: 0,
      invalidate: () => {
        invalidated += 1;
      },
      onRailRefresh: () => {
        d.refreshed += 1;
      },
    };

    expect(d.focus.railSurface).toBe("tasks");
    expect(handleFocusKey(`${String.fromCharCode(27)}[17~`, d)).toBe("handled");
    expect(d.focus.railSurface).toBe("gate");
    expect(invalidated).toBe(1);
    expect(d.refreshed).toBe(1);
  });

  test("plain G passthrough does not cycle surface", () => {
    const d = deps();

    expect(handleFocusKey("G", d)).toBeNull();
    expect(d.focus.railSurface).toBe("tasks");
  });
});

describe("handleScrollKey", () => {
  test("up arrow does not steal from the prompt editor", () => {
    const d = deps();

    d.scrollback.append("a\nb\nc\nd\ne\n");
    // Prompt-focused: arrows stay with the editor (null → passthrough).
    expect(handleScrollKey("\x1b[A", d)).toBeNull();
    expect(d.paints.length).toBe(0);
  });

  test("up arrow scrolls when scrollback is focused", () => {
    const d = deps();

    d.scrollback.append("a\nb\nc\nd\ne\n");
    d.focus.focusScrollback();
    expect(handleScrollKey("\x1b[A", d)).toBe("handled");
    expect(d.paints.length).toBe(1);
  });
  test("PageUp scrolls while prompt-focused (chrome never blocked)", () => {
    const d = deps();

    d.scrollback.append("a\nb\nc\nd\ne\nf\ng\n");
    expect(d.focus.promptFocused).toBe(true);
    expect(handleScrollKey("\x1b[5~", d)).toBe("handled");
    expect(d.paints.length).toBe(1);
  });
});

describe("handleMouseKey", () => {
  test("wheel invokes onWheel with delta and column", () => {
    const wheels: { delta: number; col: number }[] = [];
    const d = {
      ...deps(),
      onWheel: (delta: number, col: number) => {
        wheels.push({ delta, col });
      },
    };

    expect(handleMouseKey("\x1b[<64;12;4M", d)).toBe("handled");
    expect(wheels).toEqual([{ delta: 1, col: 12 }]);
    expect(handleMouseKey("\x1b[<65;80;4M", d)).toBe("handled");
    expect(wheels[1]).toEqual({ delta: -1, col: 80 });
  });
});
