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

/** Longest realistic grapheme cluster in UTF-16 code units — ZWJ emoji
 *  families run ~11-15; 32 is generous. A cluster longer than this is split,
 *  which mangles only that (pathological) glyph, never neighbouring input. */
const FIRST_CLUSTER_PREFIX = 32;

/**
 * The first grapheme cluster of `s`, segmenting only a bounded prefix.
 * `graphemes(s)[0]` segments the ENTIRE string to take one cluster — inside a
 * per-character peel loop that made a 50KB paste O(n²) (seconds of event-loop
 * freeze). This is O(1) per call.
 */
export function firstGrapheme(s: string): string | undefined {
  if (s.length === 0) {
    return undefined;
  }

  const prefix =
    s.length <= FIRST_CLUSTER_PREFIX ? s : s.slice(0, FIRST_CLUSTER_PREFIX);

  for (const { segment } of SEG.segment(prefix)) {
    return segment;
  }

  return undefined;
}
