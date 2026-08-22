import { test, expect, describe } from "bun:test";
import {
  matchPaneAction,
  normalizeInputSeq,
  resolveTuiKeybindings,
} from "../src/config/tui-keybindings";

describe("tui-keybindings", () => {
  test("default ctrl+g toggles pane", () => {
    const bindings = resolveTuiKeybindings();

    expect(matchPaneAction("\x07", bindings)).toBe("pane.toggle");
  });

  test("legacy and CSI-u ctrl+g both match toggle", () => {
    const bindings = resolveTuiKeybindings();
    const csi = `${String.fromCharCode(27)}[103;5u`;

    expect(matchPaneAction(csi, bindings)).toBe("pane.toggle");
    expect(normalizeInputSeq(csi)).toBe("\x07");
  });

  test("user override replaces default chord", () => {
    const bindings = resolveTuiKeybindings({}, { "pane.toggle": "ctrl+\\" });

    expect(matchPaneAction("\x07", bindings)).toBeNull();
    expect(matchPaneAction("\x1c", bindings)).toBe("pane.toggle");
  });

  test("ctrl+shift+g cycles surface", () => {
    const bindings = resolveTuiKeybindings();
    const csi = `${String.fromCharCode(27)}[103;6u`;

    expect(matchPaneAction(csi, bindings)).toBe("pane.cycleSurface");
  });

  test("invalid chord is dropped with warning", () => {
    const bindings = resolveTuiKeybindings(
      { "pane.toggle": "not+a+real+chord+ever" },
      {}
    );

    expect(matchPaneAction("\x07", bindings)).toBe("pane.toggle");
  });

  test("question mark opens keymap", () => {
    const bindings = resolveTuiKeybindings();

    expect(matchPaneAction("?", bindings)).toBe("keymap.show");
  });
});
