import { firstGrapheme } from "../../editor/segments";

const ESC = String.fromCharCode(27);

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
 *
 * Printable text is peeled by Unicode grapheme cluster (not UTF-16 code unit),
 * so 👋 / é stay one editor insert and Backspace deletes the whole cluster.
 */
export function takeOneInputSequence(input: string): {
  readonly seq: string;
  readonly rest: string;
} {
  if (input.length === 0) {
    return { seq: "", rest: "" };
  }

  if (input.startsWith(ESC)) {
    return peelEscapeSequence(input);
  }

  const cluster = firstGrapheme(input);

  if (cluster === undefined) {
    return { seq: "", rest: "" };
  }

  return { seq: cluster, rest: input.slice(cluster.length) };
}

/** Peel CSI / SS3 / Alt+key / bare Esc from the front of `input`. */
function peelEscapeSequence(input: string): {
  readonly seq: string;
  readonly rest: string;
} {
  // CSI: ESC [ params final
  if (input.startsWith(`${ESC}[`)) {
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
    return { seq: ESC, rest: input.slice(1) };
  }

  // SS3: ESC O A (application cursor keys)
  if (input.startsWith(`${ESC}O`) && input.length >= 3) {
    return { seq: input.slice(0, 3), rest: input.slice(3) };
  }

  // Alt+key (ESC + next grapheme), including Alt+Enter (`\x1b\r`).
  if (input.length >= 2) {
    const cluster = firstGrapheme(input.slice(1, 1 + 32));

    if (cluster !== undefined) {
      return {
        seq: `${ESC}${cluster}`,
        rest: input.slice(1 + cluster.length),
      };
    }
  }

  return { seq: ESC, rest: "" };
}

/**
 * Map Kitty CSI-u / xterm modifyOtherKeys encodings of Ctrl+G and Ctrl+O to
 * their legacy single-byte forms so pane chrome can match them.
 */
export function normalizePaneControlSeq(seq: string): string {
  // Kitty CSI-u: ESC [ codepoint ; mods u  (mods 5 = Ctrl)
  const csiU = new RegExp(`^${ESC}\\[(\\d+);(\\d+)u$`, "u").exec(seq);

  if (csiU !== null) {
    const codepoint = Number.parseInt(csiU[1] ?? "", 10);
    const mods = Number.parseInt(csiU[2] ?? "", 10);

    if (mods === 5 && codepoint === 103) {
      return "\x07"; // Ctrl+G
    }

    if (mods === 5 && codepoint === 111) {
      return "\x0f"; // Ctrl+O
    }
  }

  // xterm modifyOtherKeys: ESC [ 27 ; mods ; codepoint ~
  const xterm = new RegExp(`^${ESC}\\[27;(\\d+);(\\d+)~$`, "u").exec(seq);

  if (xterm !== null) {
    const mods = Number.parseInt(xterm[1] ?? "", 10);
    const codepoint = Number.parseInt(xterm[2] ?? "", 10);

    if (mods === 5 && codepoint === 103) {
      return "\x07";
    }

    if (mods === 5 && codepoint === 111) {
      return "\x0f";
    }
  }

  return seq;
}
