/**
 * Peel one terminal input sequence from the front of a stdin chunk.
 *
 * Pane chrome must see Ctrl+G / Esc / CSI one key at a time. Passing a whole
 * chunk like `"\x07x"` to handleKey never matches Ctrl+G and the editor gets
 * both bytes as literal text.
 *
 * Alt+key arrives as ESC + the key (`\x1b\r` for Alt+Enter). Those two bytes
 * must stay one sequence — splitting them turns Alt+Enter into Esc then Enter
 * and submits the prompt early.
 */
export function takeOneInputSequence(input: string): {
  readonly seq: string;
  readonly rest: string;
} {
  if (input.length === 0) {
    return { seq: "", rest: "" };
  }

  const esc = String.fromCharCode(27);

  if (input.startsWith(esc)) {
    // CSI: ESC [ params final
    if (input.startsWith(`${esc}[`)) {
      let i = 2;

      while (i < input.length) {
        const code = input.charCodeAt(i);

        // Final byte of CSI is @ through ~
        if (code >= 0x40 && code <= 0x7e) {
          return { seq: input.slice(0, i + 1), rest: input.slice(i + 1) };
        }

        i += 1;
      }

      // Incomplete CSI — hold the ESC alone; the rest may arrive next chunk.
      return { seq: esc, rest: input.slice(1) };
    }

    // SS3: ESC O A (application cursor keys)
    if (input.startsWith(`${esc}O`) && input.length >= 3) {
      return { seq: input.slice(0, 3), rest: input.slice(3) };
    }

    // Alt+key (ESC + next byte), including Alt+Enter (`\x1b\r`).
    if (input.length >= 2) {
      return { seq: input.slice(0, 2), rest: input.slice(2) };
    }

    return { seq: esc, rest: "" };
  }

  return { seq: input[0] ?? "", rest: input.slice(1) };
}
