import { describe, test, expect } from "bun:test";
import { decodeKeys } from "../src/editor/keys";

describe("decodeKeys", () => {
  test("plain CR is submit (return, no mods)", () => {
    const events = decodeKeys("\r");

    expect(events.length).toBe(1);

    const k = events[0];

    if (k) {
      expect({ name: k.name, shift: k.shift, alt: k.alt }).toEqual({
        name: "return",
        shift: false,
        alt: false,
      });
    }
  });

  test("Alt+Enter decodes as return+alt", () => {
    const events = decodeKeys("\x1b\r");

    expect(events.length).toBe(1);

    const k = events[0];

    if (k) {
      expect({ name: k.name, alt: k.alt }).toEqual({
        name: "return",
        alt: true,
      });
    }
  });

  test("Kitty Shift+Enter (CSI 13;2u) decodes as return+shift", () => {
    const events = decodeKeys("\x1b[13;2u");

    expect(events.length).toBe(1);

    const k = events[0];

    if (k) {
      expect({ name: k.name, shift: k.shift }).toEqual({
        name: "return",
        shift: true,
      });
    }
  });

  test("xterm modifyOtherKeys Shift+Enter (CSI 27;2;13~) decodes as return+shift", () => {
    const events = decodeKeys("\x1b[27;2;13~");

    expect(events.length).toBe(1);

    const k = events[0];

    if (k) {
      expect({ name: k.name, shift: k.shift }).toEqual({
        name: "return",
        shift: true,
      });
    }
  });

  test("Ctrl+W decodes from byte 0x17", () => {
    const events = decodeKeys("\x17");

    expect(events.length).toBe(1);

    const k = events[0];

    if (k) {
      expect({ name: k.name, ctrl: k.ctrl }).toEqual({
        name: "char",
        ctrl: true,
      });

      expect(k.text).toBe("w");
    }
  });

  test("raw Tab (0x09) decodes as tab, not ctrl+i (regression)", () => {
    const events = decodeKeys("\t");

    expect(events.length).toBe(1);

    const k = events[0];

    if (k) {
      expect({ name: k.name, ctrl: k.ctrl, text: k.text }).toEqual({
        name: "tab",
        ctrl: false,
        text: "",
      });
    }
  });

  test("Kitty Tab (CSI 9;1u) also decodes as tab", () => {
    const events = decodeKeys("\x1b[9;1u");

    expect(events.length).toBe(1);
    expect(events[0]?.name).toBe("tab");
  });

  test("Shift+Tab (CSI Z) decodes as backtab+shift", () => {
    const events = decodeKeys("\x1b[Z");

    expect(events.length).toBe(1);

    const k = events[0];

    if (k) {
      expect({ name: k.name, shift: k.shift, ctrl: k.ctrl }).toEqual({
        name: "backtab",
        shift: true,
        ctrl: false,
      });
    }
  });

  test("printable char and arrow", () => {
    const aEvents = decodeKeys("a");

    expect(aEvents.length).toBeGreaterThan(0);

    const aEvent = aEvents[0];

    if (aEvent) {
      expect(aEvent).toMatchObject({ name: "char", text: "a" });
    }

    const arrowEvents = decodeKeys("\x1b[D");

    expect(arrowEvents.length).toBeGreaterThan(0);

    const arrowEvent = arrowEvents[0];

    if (arrowEvent) {
      expect(arrowEvent).toMatchObject({ name: "left" });
    }
  });
});
