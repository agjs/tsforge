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
