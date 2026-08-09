import { test, expect, describe } from "bun:test";
import { PaneFocus } from "../src/render/frame/focus";

describe("PaneFocus", () => {
  test("togglePanel with items cycles unfocused ↔ focused", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    expect(f.panel).toBe("visibleUnfocused");

    expect(f.togglePanel(true)).toBe("changed");
    expect(f.panel).toBe("visibleFocused");
    expect(f.active).toBe("panel");

    expect(f.togglePanel(true)).toBe("changed");
    expect(f.panel).toBe("visibleUnfocused");
    expect(f.active).toBe("prompt");
  });

  test("escape from panel returns to prompt", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    f.togglePanel(true);
    expect(f.escape()).toBe("changed");
    expect(f.active).toBe("prompt");
    expect(f.panel).toBe("visibleUnfocused");
  });

  test("tab moves prompt ↔ panel when items exist", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    expect(f.tab(true)).toBe("changed");
    expect(f.active).toBe("panel");
    expect(f.tab(true)).toBe("changed");
    expect(f.active).toBe("prompt");
  });

  test("moveSelection clamps and ignores when not focused", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    expect(f.moveSelection(1, 3)).toBe("ignored");
    f.togglePanel(true);
    expect(f.moveSelection(2, 3)).toBe("changed");
    expect(f.selection).toBe(2);
    expect(f.moveSelection(9, 3)).toBe("changed");
    expect(f.selection).toBe(3);
  });

  test("syncHasItems hides panel when emptied", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    f.togglePanel(true);
    f.syncHasItems(false);
    expect(f.panel).toBe("hidden");
    expect(f.active).toBe("prompt");
  });
});
