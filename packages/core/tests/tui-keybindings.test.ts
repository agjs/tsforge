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

  test("ctrl+shift+g still matches when terminal sends CSI-u", () => {
    const bindings = resolveTuiKeybindings();
    const csi = `${String.fromCharCode(27)}[103;6u`;

    expect(matchPaneAction(csi, bindings)).toBe("pane.cycleSurface");
  });

  test("f6 is the primary default cycle chord", () => {
    const bindings = resolveTuiKeybindings();
    const f6 = `${String.fromCharCode(27)}[17~`;

    expect(bindings.display["pane.cycleSurface"][0]).toBe("f6");
    expect(matchPaneAction(f6, bindings)).toBe("pane.cycleSurface");
  });

  test("plain G does not match cycle (Mac/Cursor without modifyOtherKeys)", () => {
    const bindings = resolveTuiKeybindings();

    expect(matchPaneAction("G", bindings)).toBeNull();
    expect(matchPaneAction("g", bindings)).toBeNull();
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
