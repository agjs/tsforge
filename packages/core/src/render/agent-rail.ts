import { displayWidth } from "./width";

/** A stateful, streaming rail-wrapper for the agent card body. `feed()` is called
 *  per streamed chunk (tokens may split a line across calls, so the state persists
 *  between calls). It prefixes every visual line with the card rail and soft-wraps
 *  long lines at the card's inner width, so text can never spill past the rail —
 *  even on an auto-margin terminal or with wide chars (emoji / CJK count as 2). */
export interface IAgentRail {
  /** Rail-prefix + wrap one streamed chunk; returns the bytes to write now. */
  feed(text: string): string;
}

/**
 * @param rail       The painted `│ ` prefix (2 visible columns).
 * @param innerWidth Returns the content budget per line (columns minus the rail
 *                   and a spare margin). A function so a mid-turn resize is picked
 *                   up on the next chunk.
 */
export function makeAgentRail(
  rail: string,
  innerWidth: () => number
): IAgentRail {
  // `atStart`: at the beginning of a visual line (rail not yet emitted).
  // `seen`: real content has arrived this turn (used to swallow the leading gap).
  // `col`: visible columns used on the current line. `inEsc`: inside an ANSI SGR.
  let atStart = true;
  let seen = false;
  let col = 0;
  let inEsc = false;

  // Pass an ANSI escape byte through verbatim (escapes occupy no columns), or
  // return null when `ch` is ordinary text.
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

  return {
    feed(text: string): string {
      const wrapAt = Math.max(20, innerWidth());
      let out = "";

      for (const ch of text) {
        const esc = passEsc(ch);

        if (esc !== null) {
          out += esc;

          continue;
        }

        if (ch === "\n") {
          if (atStart) {
            if (seen) {
              out += `${rail}\n`; // interior blank line keeps the rail
            }
            // else: swallow the leading blank (no gap under the card cap)
          } else {
            out += "\n";
            atStart = true;
          }

          col = 0;

          continue;
        }

        if (atStart) {
          out += rail;
          atStart = false;
          seen = true;
          col = 0;
        } else if (col >= wrapAt) {
          out += `\n${rail}`; // soft-wrap INSIDE the rail — text never spills out
          col = 0;
        }

        out += ch;
        col += displayWidth(ch);
      }

      return out;
    },
  };
}
