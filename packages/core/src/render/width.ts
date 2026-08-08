import { graphemes } from "../editor/segments";

export { graphemes } from "../editor/segments";

/**
 * Terminal display-width helpers. A monospace cell is one column, but a CJK
 * ideograph, a fullwidth form, or a *terminal-wide* emoji occupies TWO, and
 * combining / zero-width marks occupy NONE. Everywhere we size a box, pad a
 * table cell, fit status segments, or wrap an editor line we previously counted
 * `.length` (UTF-16 code units) or grapheme count — both wrong for wide text,
 * which then overflowed or mis-aligned. These functions count *columns*,
 * building on the existing grapheme segmenter so a cluster is measured as one
 * unit.
 *
 * Widths follow what common terminals (iTerm2, Terminal.app, VTE) advance for
 * the cursor — roughly macOS/glibc `wcwidth`, *not* Unicode's ideal "every
 * emoji presentation is 2". Neutral emoji like 🛋️ (U+1F6CB) advance one cell
 * even when the glyph is double-wide; counting them as 2 under-pads closed
 * cards and zig-zags the right rail.
 */

/** Half-open `[start, end)` code-point ranges, kept sorted for a binary search. */
type Range = readonly [start: number, end: number];

/**
 * Code points that advance two columns. CJK / fullwidth plus the emoji and
 * symbol scalars that terminals actually treat as wide (`wcwidth == 2`).
 * Neutral emoji (🛋️, 🖥️, …) are intentionally absent.
 */
const WIDE: readonly Range[] = [
  [0x1100, 0x1160], // Hangul Jamo
  [0x231a, 0x231c], // watch / hourglass
  [0x2329, 0x232b], // angle brackets
  [0x2614, 0x2616], // umbrella / coffee
  [0x2648, 0x2654], // zodiac
  [0x267f, 0x2680], // wheelchair
  [0x2693, 0x2694], // anchor
  [0x26a1, 0x26a2], // high voltage
  [0x26aa, 0x26ac], // circles
  [0x26bd, 0x26bf], // soccer / baseball
  [0x26c4, 0x26c6], // snowman
  [0x26ce, 0x26cf], // Ophiuchus
  [0x26d4, 0x26d5], // no entry
  [0x26ea, 0x26eb], // church
  [0x26f2, 0x26f4], // fountain
  [0x26f5, 0x26f6], // sailboat
  [0x26fa, 0x26fb], // tent
  [0x26fd, 0x26fe], // fuel pump
  [0x2705, 0x2706], // check mark
  [0x270a, 0x270c], // fist / hand
  [0x2728, 0x2729], // sparkles
  [0x274c, 0x274d], // cross mark
  [0x274e, 0x274f], // cross mark box
  [0x2753, 0x2756], // question marks
  [0x2757, 0x2758], // exclamation
  [0x2795, 0x2798], // plus / minus
  [0x27b0, 0x27b1], // curly loop
  [0x27bf, 0x27c0], // double curly loop
  [0x2b50, 0x2b51], // star
  [0x2b55, 0x2b56], // heavy large circle
  [0x2e80, 0x303f], // CJK radicals … Kangxi
  [0x3041, 0x33ff], // Hiragana … CJK compatibility
  [0x3400, 0x4dc0], // CJK Extension A
  [0x4e00, 0xa000], // CJK Unified Ideographs
  [0xa000, 0xa4d0], // Yi
  [0xac00, 0xd7a4], // Hangul Syllables
  [0xf900, 0xfb00], // CJK Compatibility Ideographs
  [0xfe10, 0xfe1a], // Vertical forms
  [0xfe30, 0xfe70], // CJK compatibility / small forms
  [0xff00, 0xff61], // Fullwidth forms
  [0xffe0, 0xffe7], // Fullwidth signs
  [0x1f004, 0x1f005],
  [0x1f0cf, 0x1f0d0],
  [0x1f18e, 0x1f18f],
  [0x1f191, 0x1f19b],
  [0x1f200, 0x1f203],
  [0x1f210, 0x1f23c],
  [0x1f240, 0x1f249],
  [0x1f250, 0x1f252],
  [0x1f260, 0x1f266],
  [0x1f300, 0x1f321],
  [0x1f32d, 0x1f336],
  [0x1f337, 0x1f37d],
  [0x1f37e, 0x1f394],
  [0x1f3a0, 0x1f3cb],
  [0x1f3cf, 0x1f3d4],
  [0x1f3e0, 0x1f3f1],
  [0x1f3f4, 0x1f3f5],
  [0x1f3f8, 0x1f43f],
  [0x1f440, 0x1f441],
  [0x1f442, 0x1f4fd],
  [0x1f4ff, 0x1f53e],
  [0x1f54b, 0x1f54f],
  [0x1f550, 0x1f568],
  [0x1f57a, 0x1f57b],
  [0x1f595, 0x1f597],
  [0x1f5a4, 0x1f5a5], // black heart suite — not U+1F5A5 desktop
  [0x1f5fb, 0x1f650], // smileys through gesture
  [0x1f680, 0x1f6c6], // transport (stops before couch U+1F6CB)
  [0x1f6cc, 0x1f6cd],
  [0x1f6d0, 0x1f6d3],
  [0x1f6d5, 0x1f6d8],
  [0x1f6dc, 0x1f6e0],
  [0x1f6eb, 0x1f6ed],
  [0x1f6f4, 0x1f6fd],
  [0x1f7e0, 0x1f7ec],
  [0x1f7f0, 0x1f7f1],
  [0x1f90c, 0x1f93b],
  [0x1f93c, 0x1f946],
  [0x1f947, 0x1fa00],
  [0x1fa70, 0x1fa7d],
  [0x1fa80, 0x1fa89],
  [0x1fa90, 0x1fabe],
  [0x1fabf, 0x1fac6],
  [0x1face, 0x1fadc],
  [0x1fae0, 0x1fae9],
  [0x1faf0, 0x1faf9],
  [0x20000, 0x3fffe], // CJK Extension B and beyond
];

/** Code points that render zero columns: combining marks and zero-width
 *  formatting characters. Sorted ascending. */
const ZERO: readonly Range[] = [
  [0x0300, 0x0370], // Combining diacritical marks
  [0x0483, 0x048a], // Cyrillic combining
  [0x0591, 0x05c8], // Hebrew points/marks
  [0x0610, 0x061b], // Arabic marks
  [0x064b, 0x0660], // Arabic harakat
  [0x0670, 0x0671], // Arabic superscript alef
  [0x06d6, 0x06ed], // Arabic small high marks
  [0x0e31, 0x0e32], // Thai vowel
  [0x0e34, 0x0e3b], // Thai vowels/tones
  [0x1ab0, 0x1b00], // Combining diacritical extended
  [0x1dc0, 0x1e00], // Combining diacritical supplement
  [0x200b, 0x2010], // Zero-width space, ZWNJ, ZWJ, LTR/RTL marks
  [0x202a, 0x202f], // Bidi embedding/override
  [0x2060, 0x2065], // Word joiner, invisibles
  [0x20d0, 0x2100], // Combining marks for symbols
  [0xfe00, 0xfe10], // Variation selectors (VS16 = U+FE0F is zero-width)
  [0xfe20, 0xfe30], // Combining half marks
];

const RI_START = 0x1f1e6;
const RI_END = 0x1f200;

/** True if `cp` falls in any of the sorted half-open ranges (binary search). */
function inRanges(cp: number, ranges: readonly Range[]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];

    if (range === undefined) {
      break;
    }

    const [start, end] = range;

    if (cp < start) {
      hi = mid - 1;
    } else if (cp >= end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }

  return false;
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= RI_START && cp < RI_END;
}

/** The column width of a single code point: 0 (combining / zero-width / C0–C1
 *  control), 2 (wide / fullwidth / terminal-wide emoji), or 1 (everything else). */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  // C0 controls, DEL, and C1 controls render nothing meaningful here.
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
    return 0;
  }

  if (inRanges(cp, ZERO)) {
    return 0;
  }

  if (inRanges(cp, WIDE)) {
    return 2;
  }

  return 1;
}

/** The column width of one grapheme cluster. Combining marks and VS16
 *  contribute nothing — iTerm/Terminal.app do not widen a Neutral base when
 *  VS16 requests emoji presentation. ZWJ sequences take the widest scalar
 *  (typically 2). Flag pairs are special-cased to 2. */
function clusterWidth(cluster: string): number {
  let width = 0;
  let riCount = 0;
  let hasNonRi = false;

  for (const ch of cluster) {
    const cp = ch.codePointAt(0) ?? 0;

    if (isRegionalIndicator(cp)) {
      riCount += 1;
    } else if (codePointWidth(cp) > 0) {
      hasNonRi = true;
    }

    width = Math.max(width, codePointWidth(cp));
  }

  // 🇯🇵 — one grapheme, two regional indicators, two terminal columns.
  if (!hasNonRi && riCount === 2) {
    return 2;
  }

  return width;
}

/** Total terminal columns `str` occupies, measured per grapheme cluster. */
export function displayWidth(str: string): number {
  let width = 0;

  for (const cluster of graphemes(str)) {
    width += clusterWidth(cluster);
  }

  return width;
}

/**
 * The leading slice of `str` that fits in `maxWidth` columns, never splitting a
 * grapheme or landing half-way through a wide cell. Returns the slice and its
 * exact column width (≤ `maxWidth`).
 */
export function sliceToWidth(
  str: string,
  maxWidth: number
): { text: string; width: number } {
  if (maxWidth <= 0) {
    return { text: "", width: 0 };
  }

  let text = "";
  let width = 0;

  for (const cluster of graphemes(str)) {
    const w = clusterWidth(cluster);

    if (width + w > maxWidth) {
      break;
    }

    text += cluster;
    width += w;
  }

  return { text, width };
}

/**
 * Pad `str` with trailing spaces to exactly `width` columns (display width, not
 * `.length`). Strings already at or over the target are returned unchanged — the
 * column-aware analogue of `String.prototype.padEnd`.
 */
export function padToWidth(str: string, width: number): string {
  const pad = width - displayWidth(str);

  return pad > 0 ? str + " ".repeat(pad) : str;
}
