import { test, expect, describe } from "bun:test";
import { PaneFocus } from "../src/render/frame/focus";

describe("PaneFocus", () => {
  test("togglePanel opens auto-hidden rail on first Ctrl+G", () => {
    const f = new PaneFocus();

    expect(f.panel).toBe("hidden");
    expect(f.userCollapsed).toBe(false);

    expect(f.togglePanel(false)).toBe("changed");
    expect(f.panel).toBe("visibleUnfocused");
    expect(f.userCollapsed).toBe(false);
  });

  test("togglePanel hides and shows (Ctrl+G visibility)", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    expect(f.panel).toBe("visibleUnfocused");
    expect(f.userCollapsed).toBe(false);

    expect(f.togglePanel(true)).toBe("changed");
    expect(f.panel).toBe("hidden");
    expect(f.active).toBe("prompt");
    expect(f.userCollapsed).toBe(true);

    expect(f.togglePanel(true)).toBe("changed");
    expect(f.panel).toBe("visibleFocused");
    expect(f.active).toBe("panel");
    expect(f.userCollapsed).toBe(false);
  });

  test("userCollapsed blocks syncHasItems from reopening", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    f.togglePanel(true);
    expect(f.panel).toBe("hidden");

    f.syncHasItems(true);
    expect(f.panel).toBe("hidden");
    expect(f.userCollapsed).toBe(true);
  });

  test("escape from panel returns to prompt without hiding", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    f.tab(true);
    expect(f.panelFocused).toBe(true);
    expect(f.escape()).toBe("changed");
    expect(f.active).toBe("prompt");
    expect(f.panel).toBe("visibleUnfocused");
  });

  test("tab moves prompt ↔ panel when items exist and rail visible", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    expect(f.tab(true)).toBe("changed");
    expect(f.active).toBe("panel");
    expect(f.tab(true)).toBe("changed");
    expect(f.active).toBe("prompt");
  });

  test("tab ignores when rail is user-collapsed", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    f.togglePanel(true);
    expect(f.panel).toBe("hidden");
    expect(f.tab(true)).toBe("ignored");
  });

  test("moveSelection clamps and ignores when not focused", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    expect(f.moveSelection(1, 3)).toBe("ignored");
    f.tab(true);
    expect(f.moveSelection(2, 3)).toBe("changed");
    expect(f.selection).toBe(2);
    expect(f.moveSelection(9, 3)).toBe("changed");
    expect(f.selection).toBe(3);
  });

  test("cycleSurface toggles tasks and gate when rail visible", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    expect(f.cycleSurface()).toBe("changed");
    expect(f.railSurface).toBe("gate");
    expect(f.selection).toBe(0);
    expect(f.cycleSurface()).toBe("changed");
    expect(f.railSurface).toBe("tasks");
  });

  test("cycleSurface ignored when user collapsed the rail", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    f.togglePanel(true);
    expect(f.cycleSurface()).toBe("ignored");
    expect(f.railSurface).toBe("tasks");
  });

  test("cycleSurface works when rail column is up but panel state is hidden (empty checklist)", () => {
    const f = new PaneFocus();

    expect(f.panel).toBe("hidden");
    expect(f.cycleSurface()).toBe("changed");
    expect(f.railSurface).toBe("gate");
    expect(f.panel).toBe("visibleUnfocused");
  });

  test("emptied worklist hides the panel but keeps a user collapse", () => {
    const f = new PaneFocus();

    f.syncHasItems(true);
    f.togglePanel(true);
    expect(f.userCollapsed).toBe(true);

    // Content sync runs on every panel repaint (spinner ticks included), so an
    // empty worklist must not un-hide the rail the user just collapsed.
    f.syncHasItems(false);
    f.syncHasItems(false);
    expect(f.panel).toBe("hidden");
    expect(f.active).toBe("prompt");
    expect(f.userCollapsed).toBe(true);

    // Ctrl+G is the only way back.
    expect(f.togglePanel(false)).toBe("changed");
    expect(f.panel).toBe("visibleUnfocused");
    expect(f.userCollapsed).toBe(false);
  });
});
