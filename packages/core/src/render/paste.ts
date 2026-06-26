/**
 * Bracketed-paste scanner. A terminal with bracketed paste enabled (ESC[?2004h)
 * wraps a paste in ESC[200~ … ESC[201~ and delivers it (usually) as one stdin
 * chunk, with the pasted line breaks as raw CR (`\r`). readline treats each CR as
 * Enter, so without intercepting, a multi-line paste submits once per line. This
 * scanner detects the bracketed block in the raw byte stream and hands back the
 * pasted text (newlines normalized to `\n`) so the caller can drop it into the
 * input buffer instead — and exposes `active` so the caller can swallow the
 * spurious line submits readline emits for the paste's CRs until the paste closes.
 *
 * Pure + stateful-across-chunks (no I/O), so it's unit-tested against captured
 * real-terminal bytes with no TTY.
 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export interface IPasteScan {
  /** The pasted text (CR/CRLF normalized to `\n`) when a paste COMPLETED in this
   *  feed; null while no paste is active or one is still open across chunks. */
  content: string | null;
  /** True while a paste is OPEN (start seen, end not yet) — the caller suppresses
   *  readline's line submits until the paste closes and the buffer is filled. */
  active: boolean;
}

export interface IPasteScanner {
  feed(chunk: string): IPasteScan;
  isActive(): boolean;
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?|\n/gu, "\n");
}

export function createPasteScanner(): IPasteScanner {
  let active = false;
  let buf = "";

  return {
    isActive: (): boolean => active,
    feed(chunk: string): IPasteScan {
      let rest = chunk;

      if (!active) {
        const start = rest.indexOf(PASTE_START);

        if (start === -1) {
          return { content: null, active: false };
        }

        active = true;
        buf = "";
        rest = rest.slice(start + PASTE_START.length);
      }

      const end = rest.indexOf(PASTE_END);

      if (end === -1) {
        // Paste spans more chunks — keep buffering, keep swallowing submits.
        buf += rest;

        return { content: null, active: true };
      }

      buf += rest.slice(0, end);
      const content = normalizeNewlines(buf);

      active = false;
      buf = "";

      return { content, active: false };
    },
  };
}
