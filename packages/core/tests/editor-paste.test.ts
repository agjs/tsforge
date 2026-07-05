import { describe, test, expect } from "bun:test";
import { createPasteScanner } from "../src/editor/paste";

describe("PasteScanner", () => {
  test("extracts a real bracketed paste, CR→\\n, no markers", () => {
    const s = createPasteScanner();
    const chunk = "\x1b[200~line one\rline two\rlast\x1b[201~";
    const r = s.feed(chunk);

    expect(r.content).toBe("line one\nline two\nlast");
    expect(s.isActive()).toBe(false);
  });

  test("paste split across chunks stays active until the end marker", () => {
    const s = createPasteScanner();

    expect(s.feed("\x1b[200~part1\r").active).toBe(true);
    expect(s.feed("part2").content).toBeNull();
    expect(s.feed("\x1b[201~").content).toBe("part1\npart2");
  });

  test("forceEnd flushes an unterminated paste (timeout valve)", () => {
    const s = createPasteScanner();

    s.feed("\x1b[200~stuck text");
    expect(s.forceEnd()).toBe("stuck text");
    expect(s.isActive()).toBe(false);
  });

  test("decodes tmux CSI-u control bytes in paste content", () => {
    const s = createPasteScanner();
    // CSI-u format: ESC[codepoint;modu (e.g., ESC[106;5u is Ctrl-J, codepoint 10 = \n)
    // This simulates a terminal re-emitting control chars inside a paste
    const chunk = "\x1b[200~line\x1b[10;5uend\x1b[201~";
    const r = s.feed(chunk);

    expect(r.content).toBe("line\nend");
    expect(s.isActive()).toBe(false);
  });

  test("decodes astral CSI-u codepoints (emoji) whole, not truncated", () => {
    const s = createPasteScanner();
    // 👋 = U+1F44B (128075), 👌 = U+1F44C (128076) re-emitted as tmux CSI-u.
    // fromCharCode would truncate to U+F44B/U+F44C (unprintable, then stripped);
    // fromCodePoint round-trips the astral chars.
    const chunk = "\x1b[200~hi\x1b[128075;0u\x1b[128076;0u\x1b[201~";
    const r = s.feed(chunk);

    expect(r.content).toBe("hi👋👌");
    expect(Array.from(r.content ?? "", (c) => c.codePointAt(0))).toEqual([
      0x68, 0x69, 0x1f44b, 0x1f44c,
    ]);
  });

  test("an out-of-range CSI-u codepoint is dropped, not thrown", () => {
    const s = createPasteScanner();
    // 0x110000 is one past the max valid codepoint — fromCodePoint would throw
    // RangeError; the range guard drops it instead of crashing the paste.
    const chunk = "\x1b[200~a\x1b[1114112;0ub\x1b[201~";

    expect(() => s.feed(chunk)).not.toThrow();
    // re-feed on a fresh scanner (the throwing feed above consumed state)
    const s2 = createPasteScanner();

    expect(s2.feed(chunk).content).toBe("ab");
  });

  test("strips non-printable control chars except newline", () => {
    const s = createPasteScanner();
    // Include some control chars: \x00, \x01, \x1f (unit sep), \x7f (DEL)
    const chunk =
      "\x1b[200~text\x00with\x01control\x1fchars\x7fhere\n\x1b[201~";
    const r = s.feed(chunk);

    expect(r.content).toBe("textwithcontrolcharshere\n");
    expect(s.isActive()).toBe(false);
  });

  test("forceEnd returns null when no paste is active", () => {
    const s = createPasteScanner();

    expect(s.forceEnd()).toBeNull();
  });

  test("forceEnd normalizes newlines in unterminated paste", () => {
    const s = createPasteScanner();

    s.feed("\x1b[200~line1\rline2\r\nline3");
    const content = s.forceEnd();

    expect(content).toBe("line1\nline2\nline3");
    expect(s.isActive()).toBe(false);
  });

  test("CRLF normalized to LF in bracketed paste", () => {
    const s = createPasteScanner();
    const chunk = "\x1b[200~line1\r\nline2\r\nline3\x1b[201~";
    const r = s.feed(chunk);

    expect(r.content).toBe("line1\nline2\nline3");
  });

  test("trailing bytes after the end marker are returned as remainder (not dropped)", () => {
    const s = createPasteScanner();
    // Paste + trailing keystrokes coalesced into one chunk (TCP/automation).
    const r = s.feed("\x1b[200~hello\x1b[201~world");

    expect(r.content).toBe("hello");
    expect(r.remainder).toBe("world"); // must be handed back, not discarded
    expect(s.isActive()).toBe(false);
  });

  test("no remainder when nothing follows the end marker", () => {
    const s = createPasteScanner();

    expect(s.feed("\x1b[200~hi\x1b[201~").remainder).toBe("");
    expect(s.feed("plain text").remainder).toBe("");
  });
});
