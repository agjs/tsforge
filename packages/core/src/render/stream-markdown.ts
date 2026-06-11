import { formatTables, highlightCode, styleInline } from "./markdown";

/**
 * Incremental markdown renderer for the live-streamed answer (token channel
 * `content`). Append-only — no cursor tricks, so scrollback is never corrupted:
 * prose flushes as each line completes; fenced ```code``` and GFM `|` tables are
 * held and emitted fully formatted the moment their block closes, producing the
 * same output the settled renderMarkdown pass would. Pure string→string (no
 * I/O), so it is unit-testable and reusable by any front end.
 */
export class StreamingMarkdown {
  /** Trailing text of the current, not-yet-complete line. */
  private partial = "";
  /** Completed lines held while inside a fence or table block. */
  private held: string[] = [];
  private fenceLang = "";
  private mode: "prose" | "fence" | "table" = "prose";
  private streamed = false;

  /** True once any content streamed since the last reset() — the settled
   *  `message` event uses this to skip its (duplicate) full render. */
  get sawContent(): boolean {
    return this.streamed;
  }

  /** Feed a streamed chunk; returns whatever is ready to print NOW. */
  push(text: string, color: boolean): string {
    // First content of a turn opens with a blank separator, matching the
    // leading "\n" the settled message render used to add.
    let out = this.streamed ? "" : "\n";

    this.streamed = true;
    this.partial += text;

    let nl = this.partial.indexOf("\n");

    while (nl !== -1) {
      const line = this.partial.slice(0, nl);

      this.partial = this.partial.slice(nl + 1);
      out += this.takeLine(line, color);
      nl = this.partial.indexOf("\n");
    }

    return out;
  }

  /** Emit anything still held — the closing table/fence of an answer, or the
   *  partial last line on abort — and clear the buffers (not the latch). */
  flush(color: boolean): string {
    let out = "";

    if (this.mode === "fence" && this.held.length > 0) {
      out += `${highlightCode(this.held.join("\n"), this.fenceLang, color)}\n`;
    } else if (this.mode === "table") {
      out += `${formatTables(this.held.join("\n"), color)}\n`;
    }

    if (this.partial.length > 0) {
      out += `${styleInline(this.partial, color)}\n`;
    }

    this.mode = "prose";
    this.held = [];
    this.partial = "";

    return out;
  }

  /** Forget everything, including the streamed latch (turn fully consumed). */
  reset(): void {
    this.flush(false);
    this.streamed = false;
  }

  /** Consume one completed line according to the current block mode. */
  private takeLine(line: string, color: boolean): string {
    if (this.mode === "fence") {
      if (/^\s*```\s*$/.test(line)) {
        const code = highlightCode(this.held.join("\n"), this.fenceLang, color);

        this.mode = "prose";
        this.held = [];

        return `${code}\n`;
      }

      this.held.push(line);

      return "";
    }

    if (this.mode === "table") {
      if (line.includes("|")) {
        this.held.push(line);

        return "";
      }

      const block = `${formatTables(this.held.join("\n"), color)}\n`;

      this.mode = "prose";
      this.held = [];

      // The line that ended the table is a fresh prose/fence-opener line.
      return block + this.takeLine(line, color);
    }

    const fence = /^\s*```([\w-]*)\s*$/.exec(line);

    if (fence !== null) {
      this.mode = "fence";
      this.fenceLang =
        fence[1] !== undefined && fence[1].length > 0 ? fence[1] : "typescript";

      return "";
    }

    if (line.includes("|")) {
      this.mode = "table";
      this.held = [line];

      return "";
    }

    return `${styleInline(line, color)}\n`;
  }
}
