const SEG = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(s: string): string[] {
  const out: string[] = [];

  for (const { segment } of SEG.segment(s)) {
    out.push(segment);
  }

  return out;
}

export function graphemeCount(s: string): number {
  return graphemes(s).length;
}

function isCombiningMark(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

function isWideCodePoint(cp: number): boolean {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6))
  );
}

function isEmojiCodePoint(cp: number): boolean {
  return (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf);
}

export function graphemeWidth(segment: string): number {
  if (segment.length === 0) {
    return 0;
  }

  if (segment.includes("\u200d")) {
    return 2;
  }

  let width = 0;
  let sawEmoji = false;

  for (const ch of segment) {
    const cp = ch.codePointAt(0);

    if (cp === undefined || cp === 0xfe0f || isCombiningMark(cp)) {
      continue;
    }

    if (isEmojiCodePoint(cp)) {
      sawEmoji = true;
    }

    width += isWideCodePoint(cp) ? 2 : 1;
  }

  return sawEmoji ? Math.max(2, width) : width;
}

export function displayWidth(s: string): number {
  return graphemes(s).reduce((sum, segment) => sum + graphemeWidth(segment), 0);
}
