import { describe, test, expect } from "bun:test";
import { createPasteScanner } from "../src/render/paste";

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
});
