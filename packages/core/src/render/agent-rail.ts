import { STYLE, paint } from "./style";
import { clusterWidth, displayWidth, graphemes } from "./width";
import { stripSgr } from "./frame/ansi-plain";

/** A stateful, streaming rail-wrapper for the agent card body. `feed()` is called
 *  per streamed chunk (tokens may split a line across calls, so the state persists
 *  between calls). Soft-wraps at word boundaries when possible. Call `flush()` at
 *  turn end to emit a held word. When `rightRail` is set, each completed visual
 *  line is padded and closed so the card forms a solid box. */
export interface IAgentRail {
  feed(text: string): string;
  flush(): string;
}

/** Append an SGR/escape cluster to the in-progress hard-break head or rest. */
function appendEscCluster(
  cluster: string,
  head: string,
  rest: string
): { head: string; rest: string } {
  if (rest.length > 0) {
    return { head, rest: rest + cluster };
  }

  return { head: head + cluster, rest };
}

/** Hard-break `word` at `wrapAt` (grapheme-aware; SGR stays with its host). */
function takeHardBreak(
  word: string,
  wordCol: number,
  wrapAt: number
): { head: string; headCol: number; rest: string; restCol: number } {
  let head = "";
  let headCol = 0;
  let rest = "";
  let restCol = 0;
  let esc = false;

  // Grapheme-aware so `🖥️` (base + VS16) is one cluster — code-point
  // iteration used to mis-count width and under-pad the right │.
  for (const cluster of graphemes(word)) {
    if (esc) {
      ({ head, rest } = appendEscCluster(cluster, head, rest));

      if (cluster === "m") {
        esc = false;
      }

      continue;
    }

    if (cluster === "\x1b") {
      esc = true;
      ({ head, rest } = appendEscCluster(cluster, head, rest));
      continue;
    }

    const w = clusterWidth(cluster);

    if (rest.length === 0 && headCol + w <= wrapAt) {
      head += cluster;
      headCol += w;
    } else {
      rest += cluster;
      restCol += w;
    }
  }

  if (head.length === 0 && word.length > 0) {
    const first = graphemes(word)[0] ?? "";
    const w = clusterWidth(first);

    return {
      head: first,
      headCol: w,
      rest: word.slice(first.length),
      restCol: Math.max(0, wordCol - w),
    };
  }

  return { head, headCol, rest, restCol };
}

/** Foreground used by a painted rail (`│` / `│  `). */
function railFg(painted: string): string {
  if (painted.includes(STYLE.cyan)) {
    return STYLE.cyan;
  }

  if (painted.includes(STYLE.plan)) {
    return STYLE.plan;
  }

  return STYLE.chrome;
}

/**
 * @param rail       The painted left gutter (e.g. `│  ` — 3 visible columns).
 * @param innerWidth Content budget between left rail and optional right rail.
 * @param rightRail  Optional painted `│` closer — when set, lines are pad-closed.
 */
export function makeAgentRail(
  rail: string,
  innerWidth: () => number,
  rightRail = ""
): IAgentRail {
  let atStart = true;
  let seen = false;
  let lineCol = 0;
  let word = "";
  let wordCol = 0;
  let pendingSpace = false;
  let inEsc = false;
  const emptyRowFg = railFg(rightRail.length > 0 ? rightRail : rail);

  const passEsc = (ch: string): string | null => {
    if (inEsc) {
      if (ch === "m") {
        inEsc = false;
      }

      return ch;
    }

    if (ch === "\x1b") {
      inEsc = true;

      return ch;
    }

    return null;
  };

  const ensureRail = (out: string): string => {
    if (!atStart) {
      return out;
    }

    atStart = false;
    seen = true;
    lineCol = 0;

    return `${out}${rail}`;
  };

  const closeLine = (out: string, wrapAt: number): string => {
    if (rightRail.length === 0) {
      return `${out}\n`;
    }

    // ensureRail + no visible glyphs → do not leave a mid-line RESET before
    // the right │ (iTerm paints that rail dark/default on blank rows).
    if (lineCol === 0) {
      const inner = Math.max(0, displayWidth(stripSgr(rail)) - 1) + wrapAt;
      let base = out;

      if (base.endsWith(rail)) {
        base = base.slice(0, base.length - rail.length);
      }

      return `${base}${paint(`│${" ".repeat(inner)}│`, emptyRowFg, true)}\n`;
    }

    return `${out}${" ".repeat(Math.max(0, wrapAt - lineCol))}${rightRail}\n`;
  };

  const takeHard = (
    wrapAt: number
  ): { head: string; headCol: number; rest: string; restCol: number } =>
    takeHardBreak(word, wordCol, wrapAt);

  const flushWord = (out: string, wrapAt: number): string => {
    if (word.length === 0) {
      return out;
    }

    let result = out;

    while (wordCol > wrapAt) {
      pendingSpace = false;
      const { head, headCol, rest, restCol } = takeHard(wrapAt);

      result = ensureRail(result);
      result += head;
      lineCol = headCol;
      result = closeLine(result, wrapAt);
      atStart = true;
      lineCol = 0;
      word = rest;
      wordCol = restCol;
    }

    if (word.length === 0) {
      return result;
    }

    const spaceCols = pendingSpace && lineCol > 0 ? 1 : 0;

    if (lineCol > 0 && lineCol + spaceCols + wordCol > wrapAt) {
      result = closeLine(result, wrapAt);
      atStart = true;
      lineCol = 0;
      pendingSpace = false;
    } else if (pendingSpace && lineCol > 0) {
      result = ensureRail(result);
      result += " ";
      lineCol += 1;
      pendingSpace = false;
    } else {
      pendingSpace = false;
    }

    result = ensureRail(result);
    result += word;
    lineCol += wordCol;
    word = "";
    wordCol = 0;

    return result;
  };

  /** Emit a closed blank card row, or fall back to open-rail close. */
  const blankClosedRow = (out: string, wrapAt: number): string => {
    if (rightRail.length > 0) {
      const inner = Math.max(0, displayWidth(stripSgr(rail)) - 1) + wrapAt;

      return `${out}${paint(`│${" ".repeat(inner)}│`, emptyRowFg, true)}\n`;
    }

    return closeLine(ensureRail(out), wrapAt);
  };

  /** Finish the current visual line on `\n` (incl. blank closed rows). */
  const onNewline = (out: string, wrapAt: number): string => {
    let result = flushWord(out, wrapAt);

    pendingSpace = false;

    if (atStart) {
      if (seen) {
        // Blank card row: one SGR span for `│…│`. Splitting left/right
        // paints with a mid-line RESET made the right rail flash the
        // default (bright) foreground on empty rows in iTerm.
        result = blankClosedRow(result, wrapAt);
        atStart = true;
      }
    } else {
      result = closeLine(result, wrapAt);
      atStart = true;
    }

    lineCol = 0;

    return result;
  };

  return {
    feed(text: string): string {
      const wrapAt = Math.max(20, innerWidth());
      let out = "";

      for (const cluster of graphemes(text)) {
        // SGR is ASCII — walk code points so the escape state machine stays intact.
        if (inEsc || cluster === "\x1b") {
          for (const ch of cluster) {
            const esc = passEsc(ch);

            if (esc !== null) {
              word += esc;
            }
          }

          continue;
        }

        if (cluster === "\n") {
          out = onNewline(out, wrapAt);
          continue;
        }

        if (cluster === " ") {
          out = flushWord(out, wrapAt);
          pendingSpace = true;

          continue;
        }

        word += cluster;
        wordCol += clusterWidth(cluster);

        if (wordCol > wrapAt) {
          out = flushWord(out, wrapAt);
        }
      }

      return out;
    },

    flush(): string {
      const wrapAt = Math.max(20, innerWidth());
      let out = flushWord("", wrapAt);

      // Only pad-close when a right rail is active; otherwise leave the open
      // line as-is (no forced trailing newline — callers own line endings).
      if (!atStart && rightRail.length > 0) {
        out = closeLine(out, wrapAt);
        atStart = true;
        lineCol = 0;
      }

      return out;
    },
  };
}
