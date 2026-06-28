import { graphemes } from "../editor/segments";

export { graphemes } from "../editor/segments";

/**
 * Terminal display-width helpers. A monospace cell is one column, but a CJK
 * ideograph, a fullwidth form, or an emoji occupies TWO, and combining /
 * zero-width marks occupy NONE. Everywhere we size a box, pad a table cell, fit
 * status segments, or wrap an editor line we previously counted `.length`
 * (UTF-16 code units) or grapheme count — both wrong for wide text, which then
 * overflowed or mis-aligned. These functions count *columns*, building on the
 * existing grapheme segmenter so a cluster is measured as one unit.
 */

/** Half-open `[start, end)` code-point ranges, kept sorted for a binary search. */
type Range = readonly [start: number, end: number];

/** Code points that render two columns wide: East Asian Wide/Fullwidth plus the
 *  emoji blocks that terminals draw double-width. Sorted ascending. */
const WIDE: readonly Range[] = [
  [0x1100, 0x1160], // Hangul Jamo
  [0x2329, 0x232b], // angle brackets
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
  [0x1f1e6, 0x1f200], // Regional indicators (flags)
  [0x1f300, 0x1f650], // Misc symbols, emoticons
  [0x1f680, 0x1f700], // Transport & map
  [0x1f900, 0x1fa00], // Supplemental symbols & pictographs
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
  [0xfe00, 0xfe10], // Variation selectors (see VS16 note below)
  [0xfe20, 0xfe30], // Combining half marks
];

/** Variation Selector-16 forces emoji (wide) presentation of the preceding
 *  base character, so a cluster containing it is two columns regardless of the
 *  base's own width (e.g. `#️`, `❤️`). */
const VS16 = 0xfe0f;

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

/** The column width of a single code point: 0 (combining / zero-width / C0–C1
 *  control), 2 (wide / fullwidth / emoji), or 1 (everything else). */
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

/** The column width of one grapheme cluster: zero-width if its base is, two if
 *  it carries VS16 or any wide code point, else the base width. Combining marks
 *  contribute nothing, so `e` + accent is still one column. */
function clusterWidth(cluster: string): number {
  let width = 0;
  let hasVs16 = false;

  for (const ch of cluster) {
    const cp = ch.codePointAt(0) ?? 0;

    if (cp === VS16) {
      hasVs16 = true;
    }

    // The cluster's width is the widest of its code points: a base (1 or 2)
    // dominates its trailing combining marks (0).
    width = Math.max(width, codePointWidth(cp));
  }

  return hasVs16 ? 2 : width;
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
